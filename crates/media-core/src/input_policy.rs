//! Decoder inputs use a finite demuxer set. HLS is allowed only behind the
//! typed, rewriting Worker HTTP gateway, never for arbitrary local/NAS files.
const FILE_FORMATS: &str =
    "mov,matroska,webm,mpegts,aac,mp3,ogg,flac,wav,webvtt,srt,ass,ssa,jpeg_pipe,png_pipe,webp_pipe";
pub fn args(network: bool, rewritten_hls: bool) -> Vec<String> {
    let formats = if rewritten_hls {
        format!("{FILE_FORMATS},hls")
    } else {
        FILE_FORMATS.into()
    };
    vec![
        "-protocol_whitelist".into(),
        if network {
            "http,tcp,crypto"
        } else {
            "file,pipe"
        }
        .into(),
        "-format_whitelist".into(),
        formats,
    ]
}
/// Add input restrictions immediately before the first input, not as output options.
pub fn constrain(args: &mut Vec<String>, network: bool, rewritten_hls: bool) {
    let at = args
        .iter()
        .position(|v| v == "-i")
        .expect("one decoder input");
    args.splice(at..at, self::args(network, rewritten_hls));
}
pub fn clean_environment(command: &mut tokio::process::Command) {
    // Decoder/probe children never need service or object-store credentials.
    // This minimizes inherited environment; it is not an OS/filesystem sandbox.
    let scoped_names: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(name, _)| name)
        .chain(command.as_std().get_envs().map(|(name, _)| name.to_owned()))
        .filter(|name| name.to_string_lossy().starts_with("RAINSYNC_S3_"))
        .collect();
    for name in scoped_names {
        command.env_remove(name);
    }
    for name in [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "FFREPORT",
        "DATABASE_URL",
        "SOURCE_ENCRYPTION_KEY",
        "ADMIN_PASSWORD",
        "SERVER_INTERNAL_URL",
        "RAINSYNC_CONTROL_PEER_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONFIG_FILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    ] {
        command.env_remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn object_store_environment_and_credential_handles_are_not_inherited() {
        let mut command = tokio::process::Command::new("never-spawned-fixture");
        for key in [
            "RAINSYNC_S3_ACCOUNT_ONE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
        ] {
            command.env(key, "synthetic-only");
        }
        command.env("PATH", "/fixture/tools");
        clean_environment(&mut command);
        for key in [
            "RAINSYNC_S3_ACCOUNT_ONE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
        ] {
            assert!(
                command
                    .as_std()
                    .get_envs()
                    .any(|(name, value)| name == key && value.is_none())
            );
        }
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(name, value)| name == "PATH"
                    && value == Some(std::ffi::OsStr::new("/fixture/tools")))
        );
    }
    #[test]
    fn decoder_children_do_not_inherit_known_service_secrets() {
        let mut command = tokio::process::Command::new("fixture-only-not-spawned");
        for name in [
            "DATABASE_URL",
            "SOURCE_ENCRYPTION_KEY",
            "ADMIN_PASSWORD",
            "SERVER_INTERNAL_URL",
        ] {
            command.env(name, "fixture");
        }
        clean_environment(&mut command);
        let env = command.as_std().get_envs().collect::<Vec<_>>();
        for name in [
            "DATABASE_URL",
            "SOURCE_ENCRYPTION_KEY",
            "ADMIN_PASSWORD",
            "SERVER_INTERNAL_URL",
        ] {
            assert!(
                env.iter()
                    .any(|(key, value)| *key == std::ffi::OsStr::new(name) && value.is_none())
            );
        }
    }
    #[test]
    fn media_children_do_not_inherit_service_credentials() {
        let mut command = tokio::process::Command::new("never-executed-fixture");
        let secrets = [
            "DATABASE_URL",
            "SOURCE_ENCRYPTION_KEY",
            "ADMIN_PASSWORD",
            "SERVER_INTERNAL_URL",
        ];
        for key in secrets {
            command.env(key, "synthetic-fixture-only");
        }
        clean_environment(&mut command);
        for key in secrets {
            assert!(
                command
                    .as_std()
                    .get_envs()
                    .any(|(name, value)| name == key && value.is_none())
            );
        }
    }
    #[test]
    fn local_inputs_cannot_enable_network_or_reference_demuxers() {
        let a = args(false, false);
        assert_eq!(a[1], "file,pipe");
        for bad in ["hls", "dash", "concat", "image2", "sdp", "rtsp"] {
            assert!(!a[3].split(',').any(|s| s == bad));
        }
    }
    #[test]
    fn rewritten_hls_is_explicit_and_input_scoped() {
        let mut a = vec![
            "-ss".into(),
            "4".into(),
            "-i".into(),
            "http://127.0.0.1/input".into(),
            "output".into(),
        ];
        constrain(&mut a, true, true);
        assert_eq!(&a[2..6], args(true, true).as_slice());
        assert_eq!(a[6], "-i");
        assert!(a[5].ends_with(",hls"));
    }
}
