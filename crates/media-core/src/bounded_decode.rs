//! Linux resource ceiling for a finite immutable pipe-only qualification job.
//! Installing limits does not prove decode success or process disposal.
pub const ADDRESS_SPACE_BYTES: u64 = 512 * 1024 * 1024;
pub const CPU_SECONDS: u64 = 20;
pub fn install(command: &mut tokio::process::Command) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // Only async-signal-safe calls run in the child between fork and exec.
        unsafe {
            command.pre_exec(|| {
                for (resource, maximum) in [
                    (libc::RLIMIT_AS, ADDRESS_SPACE_BYTES),
                    (libc::RLIMIT_CPU, CPU_SECONDS),
                ] {
                    let bound = libc::rlimit {
                        rlim_cur: maximum,
                        rlim_max: maximum,
                    };
                    if libc::setrlimit(resource, &bound) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        anyhow::bail!("bounded_decode_linux_required")
    }
}
