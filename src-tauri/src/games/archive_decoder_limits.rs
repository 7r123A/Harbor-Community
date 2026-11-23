use std::process::{Child, Command};

// One archive worker; 7z uses two decode threads and UnRAR one. Windows limits committed
// memory; Linux limits data allocations separately from its larger mapped address space.
// Allocation failures stay inside the worker.
pub const MEMORY: usize = 512 * 1024 * 1024;
#[cfg(target_os = "linux")]
const LINUX_ADDRESS_SPACE: usize = 2 * 1024 * 1024 * 1024;
pub fn worker_started() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::{
            SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
        };
        // Decoder failure belongs in Harbor's inline status, never an OS dialog.
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}
pub fn configure(command: &mut Command) {
    configure_with_file_limit(command, 0);
}
pub fn configure_with_file_limit(command: &mut Command, file_limit: u64) {
    // libudfread's optional diagnostic environment must never create a file.
    command
        .env_remove("UDFREAD_LOG_FILE")
        .env_remove("UDFREAD_LOG")
        .env_remove("UDFREAD_TRACE");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_4000); // hidden, below-normal priority
    }
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(move || {
            // RLIMIT_AS counts the Rust executable, shared libraries and reserved thread
            // stacks. The 512 MiB ceiling can reject valid 7z decoding on Linux even when
            // the decompressor's allocations are well below that budget. On Linux 4.7+,
            // RLIMIT_DATA also covers anonymous mmap allocations (including Rust heaps).
            #[cfg(target_os = "linux")]
            {
                let data = libc::rlimit {
                    rlim_cur: MEMORY as _,
                    rlim_max: MEMORY as _,
                };
                if libc::setrlimit(libc::RLIMIT_DATA, &data) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            #[cfg(target_os = "linux")]
            let address_space = LINUX_ADDRESS_SPACE;
            #[cfg(not(target_os = "linux"))]
            let address_space = MEMORY;
            let limit = libc::rlimit {
                rlim_cur: address_space as _,
                rlim_max: address_space as _,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let zero = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_CORE, &zero) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Archives write no files; migration workers write only their owned snapshot.
            let files = libc::rlimit {
                rlim_cur: file_limit as _,
                rlim_max: file_limit as _,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &files) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            libc::nice(10);
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    #[cfg(not(any(windows, unix)))]
    let _ = command;
    #[cfg(not(unix))]
    let _ = file_limit;
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn worker_keeps_linux_allocation_cap_with_room_for_runtime_mappings() {
        // Run through the production pre-exec setup and inspect both limits in the child.
        let mut command = Command::new("sh");
        command.args(["-c", "ulimit -d; ulimit -v"]);
        configure(&mut command);
        let output = command.output().expect("spawn limited worker");
        assert!(output.status.success(), "read limited worker limits");
        let stdout = String::from_utf8(output.stdout).expect("numeric shell limits");
        let limits: Vec<usize> = stdout
            .lines()
            .map(|line| line.trim().parse().expect("limit in KiB"))
            .collect();
        assert_eq!(limits, vec![MEMORY / 1024, LINUX_ADDRESS_SPACE / 1024]);
    }
}
#[cfg(windows)]
pub struct Limits(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Limits {
    pub fn attach(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::{
            core::PCWSTR,
            Win32::{Foundation::HANDLE, System::JobObjects::*},
        };
        unsafe {
            let guard = Self(CreateJobObjectW(None, PCWSTR::null())?);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = 1;
            info.ProcessMemoryLimit = MEMORY;
            SetInformationJobObject(
                guard.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )?;
            // Input is sent only after assignment succeeds, before any archive parsing.
            AssignProcessToJobObject(guard.0, HANDLE(child.as_raw_handle()))?;
            Ok(guard)
        }
    }
}
#[cfg(windows)]
impl Drop for Limits {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
pub struct Limits;
#[cfg(not(windows))]
impl Limits {
    pub fn attach(_: &Child) -> std::io::Result<Self> {
        if cfg!(unix) {
            Ok(Self)
        } else {
            Err(std::io::Error::other("archive_platform"))
        }
    }
}
