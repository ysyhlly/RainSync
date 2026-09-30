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
    for name in [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "FFREPORT",
    ] {
        command.env_remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
