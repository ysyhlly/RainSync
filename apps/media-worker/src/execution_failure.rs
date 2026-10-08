use std::{future::Future, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

const LINE_LIMIT: usize = 2048;
const TOTAL_LIMIT: usize = 64 * 1024;
const READ_SIZE: usize = 512;
const DRAIN_GRACE: Duration = Duration::from_millis(250);
const LEGACY_INVALID_SUFFIX: &str = ": Invalid data found when processing input";

/// Advisory categories only. Stderr can contain untrusted media text and is
/// never evidence for permissions, automatic retries, or content integrity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    InputInvalid,
    DecoderUnavailable,
    EncoderUnavailable,
}

/// Drain stderr alongside the process supervisor without spawning another
/// task or cancelling supervision. Only callers with a typed nonzero encoder
/// exit may use the category, after stronger source/input/capacity failures.
/// Success, shutdown, and lease interruption must retain their own behavior.
pub async fn observe<F>(
    supervision: F,
    stderr: impl AsyncRead + Unpin,
) -> (anyhow::Result<()>, Option<Kind>)
where
    F: Future<Output = anyhow::Result<()>>,
{
    observe_inner(supervision, stderr, None).await
}

/// Also recognize FFmpeg 5.1's input-opening diagnostic only when its entire
/// filename equals the exact argument supplied to this execution. Borrow that
/// existing argument for observation only; never copy, export, or log it.
/// This has the same advisory semantics and supervision guards as `observe`.
pub async fn observe_with_input<F>(
    supervision: F,
    stderr: impl AsyncRead + Unpin,
    expected_input: &str,
) -> (anyhow::Result<()>, Option<Kind>)
where
    F: Future<Output = anyhow::Result<()>>,
{
    let expected_input = (!expected_input.is_empty()
        && expected_input.len() <= LINE_LIMIT - LEGACY_INVALID_SUFFIX.len()
        && !expected_input.chars().any(char::is_control))
    .then_some(expected_input);
    match expected_input {
        Some(input) => observe_inner(supervision, stderr, Some(input)).await,
        None => observe(supervision, stderr).await,
    }
}

async fn observe_inner<F>(
    supervision: F,
    stderr: impl AsyncRead + Unpin,
    expected_input: Option<&str>,
) -> (anyhow::Result<()>, Option<Kind>)
where
    F: Future<Output = anyhow::Result<()>>,
{
    let drain = drain(stderr, expected_input);
    tokio::pin!(supervision, drain);
    tokio::select! {
        biased;
        result = &mut supervision => {
            // An inherited pipe can outlive the supervised process tree. A
            // partial diagnostic stream is unknown, even if it matched earlier.
            let kind = tokio::time::timeout(DRAIN_GRACE, &mut drain)
                .await
                .unwrap_or(None);
            (result, kind)
        }
        kind = &mut drain => (supervision.await, kind),
    }
}

async fn drain(mut stderr: impl AsyncRead + Unpin, expected_input: Option<&str>) -> Option<Kind> {
    let mut evidence = Evidence::default();
    let mut buffer = [0; READ_SIZE];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => return evidence.finish(expected_input),
            Ok(count) => evidence.push(&buffer[..count], expected_input),
            Err(_) => return None,
        }
        buffer.fill(0);
        // Also cooperate for an always-ready reader or a diagnostic flood.
        // This lets supervision and the post-exit timeout keep making progress.
        tokio::task::yield_now().await;
    }
}

struct Evidence {
    line: [u8; LINE_LIMIT],
    length: usize,
    total: usize,
    kind: Option<Kind>,
    invalid: bool,
}

impl Default for Evidence {
    fn default() -> Self {
        Self {
            line: [0; LINE_LIMIT],
            length: 0,
            total: 0,
            kind: None,
            invalid: false,
        }
    }
}

impl Evidence {
    fn invalidate(&mut self) {
        self.invalid = true;
        self.kind = None;
        self.line.fill(0);
        self.length = 0;
    }

    fn push(&mut self, bytes: &[u8], expected_input: Option<&str>) {
        if self.invalid {
            return;
        }
        // Reaching the budget loses classification rather than trusting an
        // incomplete prefix. The reader still drains all subsequent bytes.
        if bytes.len() >= TOTAL_LIMIT - self.total {
            self.invalidate();
            return;
        }
        self.total += bytes.len();
        for &byte in bytes {
            if byte == b'\n' {
                self.end_line(expected_input);
                if self.invalid {
                    return;
                }
            } else if self.length == LINE_LIMIT {
                self.invalidate();
                return;
            } else {
                self.line[self.length] = byte;
                self.length += 1;
            }
        }
    }

    fn end_line(&mut self, expected_input: Option<&str>) {
        let bytes = &self.line[..self.length];
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        let Ok(line) = std::str::from_utf8(bytes) else {
            self.invalidate();
            return;
        };
        if line.chars().any(|c| c.is_control() && c != '\t') {
            self.invalidate();
            return;
        }
        if let Some(kind) = classify(line, expected_input) {
            if self.kind.is_some_and(|previous| previous != kind) {
                self.invalidate();
                return;
            }
            self.kind = Some(kind);
        }
        self.line[..self.length].fill(0);
        self.length = 0;
    }

    fn finish(mut self, expected_input: Option<&str>) -> Option<Kind> {
        if !self.invalid && self.length != 0 {
            self.end_line(expected_input);
        }
        self.kind
    }
}

// Match whole diagnostic messages, never arbitrary substrings/paths, errno
// text, HTTP errors, metadata values, or general codec/opening errors.
// FFmpeg 5.1 find_codec_or_die and 7.1 ffmpeg_demux/ffmpeg_opt emit these
// messages; unsupported versions/formatting safely remain unknown.
fn classify(line: &str, expected_input: Option<&str>) -> Option<Kind> {
    // FFmpeg 5.1 open_input_file calls print_error(filename, err), which emits
    // "%s: %s\n". Compare the original line before considering a log prefix:
    // arbitrary context or a foreign filename cannot impersonate this input.
    if expected_input.is_some_and(|input| line.strip_suffix(LEGACY_INVALID_SUFFIX) == Some(input)) {
        return Some(Kind::InputInvalid);
    }
    let line = diagnostic_message(line)?;
    if quoted_codec(line, "Unknown encoder '")
        || line == "Error opening output files: Encoder not found"
    {
        return Some(Kind::EncoderUnavailable);
    }
    if quoted_codec(line, "Unknown decoder '")
        || line == "Error opening input files: Decoder not found"
        || line
            .strip_prefix("Decoding requested, but no decoder found for: ")
            .is_some_and(codec_name)
        || missing_decoder(line)
    {
        return Some(Kind::DecoderUnavailable);
    }
    if matches!(
        line,
        "Error opening input: Invalid data found when processing input"
            | "Error opening input files: Invalid data found when processing input"
    ) {
        return Some(Kind::InputInvalid);
    }
    None
}

fn quoted_codec(line: &str, prefix: &str) -> bool {
    line.strip_prefix(prefix)
        .and_then(|name| name.strip_suffix('\''))
        .is_some_and(codec_name)
}

fn codec_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn missing_decoder(line: &str) -> bool {
    let Some((codec, stream)) = line
        .strip_prefix("Decoder (codec ")
        .and_then(|line| line.split_once(") not found for input stream #"))
    else {
        return false;
    };
    let Some((file, stream)) = stream.split_once(':') else {
        return false;
    };
    codec_name(codec) && decimal(file) && decimal(stream)
}

fn decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn diagnostic_message(line: &str) -> Option<&str> {
    if !line.starts_with('[') {
        // Do not trim: FFmpeg indents metadata, including embedded media text.
        return Some(line);
    }
    let (context, message) = line.strip_prefix('[')?.split_once("] ")?;
    let (name, pointer) = context.split_once(" @ 0x")?;
    if name.is_empty()
        || name.len() > 128
        || !name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'_' | b'-' | b'.' | b',' | b'#' | b':' | b'/')
        })
        || pointer.is_empty()
        || pointer.len() > 16
        || !pointer.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        task::{Context, Poll},
    };
    use tokio::io::{AsyncWriteExt, ReadBuf};

    struct Chunked {
        data: Vec<u8>,
        position: usize,
        chunk: usize,
        consumed: Arc<AtomicUsize>,
        fail_at_end: bool,
    }

    impl Chunked {
        fn new(data: impl Into<Vec<u8>>, chunk: usize) -> Self {
            Self {
                data: data.into(),
                position: 0,
                chunk,
                consumed: Arc::default(),
                fail_at_end: false,
            }
        }
    }

    impl AsyncRead for Chunked {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if self.position == self.data.len() && self.fail_at_end {
                return Poll::Ready(Err(io::Error::other("private-token/raw/path")));
            }
            let count = (self.data.len() - self.position)
                .min(self.chunk)
                .min(buffer.remaining());
            buffer.put_slice(&self.data[self.position..self.position + count]);
            self.position += count;
            self.consumed.fetch_add(count, Ordering::Relaxed);
            Poll::Ready(Ok(()))
        }
    }

    async fn category(data: impl Into<Vec<u8>>, chunk: usize) -> Option<Kind> {
        let (result, kind) = observe(async { Ok(()) }, Chunked::new(data, chunk)).await;
        result.unwrap();
        kind
    }

    async fn input_category(
        data: impl Into<Vec<u8>>,
        chunk: usize,
        expected_input: &str,
    ) -> Option<Kind> {
        let (result, kind) =
            observe_with_input(async { Ok(()) }, Chunked::new(data, chunk), expected_input).await;
        result.unwrap();
        kind
    }

    // These are source-contract fixtures for official FFmpeg 5.1
    // open_input_file/print_error, not a claim of testing a 5.1 executable.
    #[tokio::test]
    async fn ffmpeg_51_source_contract_matches_only_the_exact_expected_input() {
        for input in [
            "http://127.0.0.1:8149/source/file?token=private-token&execution=attempt",
            "/private/media/source.mkv",
            "/private/media/视频 clip.mkv",
        ] {
            let data = format!("{input}{LEGACY_INVALID_SUFFIX}\r\n");
            for chunk in [1, 7, 512] {
                let kind = input_category(data.as_bytes(), chunk, input).await;
                assert_eq!(kind, Some(Kind::InputInvalid));
                assert_eq!(format!("{kind:?}"), "Some(InputInvalid)");
            }
            assert_eq!(category(data.as_bytes(), 7).await, None);
            assert_eq!(
                input_category(data.as_bytes(), 7, "/foreign/media/source.mkv").await,
                None
            );
        }
    }

    #[tokio::test]
    async fn legacy_equality_is_checked_before_any_log_prefix_stripping() {
        let input = "/private/media/source.mkv";
        for data in [
            format!("[in#0 @ 0xabcdef] {input}{LEGACY_INVALID_SUFFIX}\n"),
            format!("prefix {input}{LEGACY_INVALID_SUFFIX}\n"),
            format!(" {input}{LEGACY_INVALID_SUFFIX}\n"),
            format!("{input}{LEGACY_INVALID_SUFFIX} trailing\n"),
        ] {
            assert_eq!(input_category(data, 3, input).await, None);
        }
        // A literal filename which resembles a log prefix is still compared
        // byte-for-byte; its exact diagnostic is not rewritten by the parser.
        let input = "[in#0 @ 0xabcdef] /private/media/source.mkv";
        assert_eq!(
            input_category(format!("{input}{LEGACY_INVALID_SUFFIX}\n"), 3, input).await,
            Some(Kind::InputInvalid)
        );
    }

    #[tokio::test]
    async fn legacy_empty_control_newline_and_oversized_inputs_are_rejected() {
        for input in [
            "",
            "/private/\nsource.mkv",
            "/private/\rsource.mkv",
            "/private/\tsource.mkv",
            "/private/\0source.mkv",
            "/private/\u{0085}source.mkv",
        ] {
            assert_eq!(
                input_category(format!("{input}{LEGACY_INVALID_SUFFIX}\n"), 3, input).await,
                None
            );
        }
        let input = "x".repeat(LINE_LIMIT - LEGACY_INVALID_SUFFIX.len());
        assert_eq!(
            input_category(format!("{input}{LEGACY_INVALID_SUFFIX}\n"), 512, &input).await,
            Some(Kind::InputInvalid)
        );
        let oversized = format!("{input}x");
        assert_eq!(
            input_category(
                format!("{oversized}{LEGACY_INVALID_SUFFIX}\n"),
                512,
                &oversized
            )
            .await,
            None
        );
    }

    #[tokio::test]
    async fn legacy_evidence_keeps_conflict_and_total_budget_guards() {
        let input = "/private/media/source.mkv";
        let legacy = format!("{input}{LEGACY_INVALID_SUFFIX}\n");
        assert_eq!(
            input_category(format!("{legacy}Unknown decoder 'hevc'\n"), 7, input).await,
            None
        );
        let mut flood = legacy.as_bytes().to_vec();
        flood.resize(TOTAL_LIMIT + 1024, b'\n');
        let reader = Chunked::new(flood, 512);
        let consumed = reader.consumed.clone();
        let (result, kind) = observe_with_input(async { Ok(()) }, reader, input).await;
        result.unwrap();
        assert_eq!(kind, None);
        assert_eq!(consumed.load(Ordering::Relaxed), TOTAL_LIMIT + 1024);
    }

    #[tokio::test]
    async fn expected_input_does_not_change_modern_diagnostic_classification() {
        for input in ["/private/source.mkv", "", "/private/\nsource.mkv"] {
            assert_eq!(
                input_category(b"Unknown encoder 'libx264'\n", 7, input).await,
                Some(Kind::EncoderUnavailable)
            );
            assert_eq!(
                input_category(
                    b"[in#0 @ 0xabcdef] Error opening input: Invalid data found when processing input\n",
                    7,
                    input,
                )
                .await,
                Some(Kind::InputInvalid)
            );
        }
    }

    #[tokio::test]
    async fn chunk_boundaries_crlf_and_final_line_preserve_narrow_signatures() {
        let input = b"ffmpeg banner\n[vost#0:0 @ 0x123abc] Unknown encoder 'libx264'\r\nUnknown encoder 'libx264'";
        for chunk in 1..=input.len() {
            assert_eq!(category(input, chunk).await, Some(Kind::EncoderUnavailable));
        }
        assert_eq!(
            category(
                b"Decoder (codec hevc) not found for input stream #0:12\n",
                7
            )
            .await,
            Some(Kind::DecoderUnavailable)
        );
        assert_eq!(
            category(
                b"[vist#0:0/hevc @ 0xabcdef] Decoding requested, but no decoder found for: hevc\n",
                3
            )
            .await,
            Some(Kind::DecoderUnavailable)
        );
    }

    #[tokio::test]
    async fn paths_and_tokens_only_produce_a_fixed_category() {
        let output = b"Error opening input file /private/secret-token.mkv.\n[in#0 @ 0xabcdef] Error opening input: Invalid data found when processing input\nError opening input files: Invalid data found when processing input\n";
        let (result, kind) = observe(async { Ok(()) }, Chunked::new(output, 7)).await;
        result.unwrap();
        assert_eq!(kind, Some(Kind::InputInvalid));
        assert_eq!(format!("{kind:?}"), "Some(InputInvalid)");
    }

    #[tokio::test]
    async fn metadata_unknown_errors_and_conflicting_categories_are_unknown() {
        for input in [
            "    title : Unknown encoder 'libx264'\n",
            "  Unknown decoder 'hevc'\n",
            "prefix Unknown encoder 'libx264'\n",
            "Unknown encoder 'libx264' trailing\n",
            "Unknown encoder '/private/token'\n",
            "[arbitrary private text @ 0x123] Unknown encoder 'libx264'\n",
            "Connection reset by peer\nResource temporarily unavailable\n",
            "HTTP error 503 Service Unavailable\nNo space left on device\n",
            "Error opening output files: Invalid data found when processing input\n",
            "Unknown encoder 'libx264'\nUnknown decoder 'hevc'\n",
            "Unknown encoder 'libx264'\nError opening input files: Invalid data found when processing input\n",
        ] {
            assert_eq!(category(input, 2).await, None, "{input:?}");
        }
    }

    #[tokio::test]
    async fn malformed_or_oversized_evidence_invalidates_an_earlier_match() {
        for suffix in [
            vec![0xff, b'\n'],
            b"terminal\x1b[31m\n".to_vec(),
            b"text\0hidden\n".to_vec(),
            vec![b'x'; LINE_LIMIT + 1],
        ] {
            let mut data = b"Unknown encoder 'libx264'\n".to_vec();
            data.extend(suffix);
            let length = data.len();
            let reader = Chunked::new(data, 31);
            let consumed = reader.consumed.clone();
            assert_eq!(observe(async { Ok(()) }, reader).await.1, None);
            assert_eq!(consumed.load(Ordering::Relaxed), length);
        }
    }

    #[tokio::test]
    async fn exact_line_limit_is_accepted_but_total_budget_is_unknown() {
        let mut data = vec![b'x'; LINE_LIMIT];
        data.extend(b"\nUnknown encoder 'libx264'\n");
        assert_eq!(category(data, 512).await, Some(Kind::EncoderUnavailable));
        let mut data = b"Unknown encoder 'libx264'\n".to_vec();
        while data.len() < TOTAL_LIMIT {
            data.push(b'\n');
        }
        assert_eq!(category(data, 512).await, None);
    }

    #[tokio::test]
    async fn oversized_line_and_total_flood_are_drained_under_backpressure() {
        for many_lines in [false, true] {
            let (reader, mut writer) = tokio::io::duplex(32);
            let producer = async {
                writer
                    .write_all(b"Unknown encoder 'libx264'\n")
                    .await
                    .unwrap();
                let chunk = if many_lines {
                    [b'\n'; 1024]
                } else {
                    [b'x'; 1024]
                };
                for _ in 0..128 {
                    writer.write_all(&chunk).await.unwrap();
                }
                writer.shutdown().await.unwrap();
                Ok(())
            };
            let (result, kind) =
                tokio::time::timeout(Duration::from_secs(2), observe(producer, reader))
                    .await
                    .unwrap();
            result.unwrap();
            assert_eq!(kind, None);
        }
    }

    #[tokio::test]
    async fn read_failure_discards_evidence_and_preserves_supervisor_error() {
        #[derive(Debug)]
        struct SupervisorFailure;
        impl std::fmt::Display for SupervisorFailure {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("supervisor_failure")
            }
        }
        impl std::error::Error for SupervisorFailure {}
        let mut reader = Chunked::new(b"Unknown encoder 'libx264'\n", 512);
        reader.fail_at_end = true;
        let (result, kind) = observe(async { Err(SupervisorFailure.into()) }, reader).await;
        assert!(result.unwrap_err().is::<SupervisorFailure>());
        assert_eq!(kind, None);
    }

    #[tokio::test]
    async fn early_eof_still_waits_for_supervision() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut observation = Box::pin(observe(
            async { receiver.await.unwrap() },
            Chunked::new(b"Unknown decoder 'hevc'\n", 512),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut observation)
                .await
                .is_err()
        );
        sender.send(Ok(())).unwrap();
        let (result, kind) = observation.await;
        result.unwrap();
        assert_eq!(kind, Some(Kind::DecoderUnavailable));
    }

    #[tokio::test]
    async fn an_open_pipe_after_supervision_is_bounded_and_unknown() {
        let (reader, mut writer) = tokio::io::duplex(64);
        writer
            .write_all(b"Unknown encoder 'libx264'\n")
            .await
            .unwrap();
        let began = tokio::time::Instant::now();
        let (result, kind) = tokio::time::timeout(
            Duration::from_secs(1),
            observe(async { anyhow::bail!("supervisor_failure") }, reader),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().to_string(), "supervisor_failure");
        assert_eq!(kind, None);
        assert!(began.elapsed() >= DRAIN_GRACE);
        assert!(writer.write_all(b"later").await.is_err());
    }

    struct PendingReader(Arc<AtomicBool>);
    impl AsyncRead for PendingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }
    impl Drop for PendingReader {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[tokio::test]
    async fn cancellation_drops_the_reader_without_detached_work() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut observation = Box::pin(observe(
            std::future::pending::<anyhow::Result<()>>(),
            PendingReader(dropped.clone()),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut observation)
                .await
                .is_err()
        );
        assert!(!dropped.load(Ordering::Relaxed));
        drop(observation);
        assert!(dropped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    #[ignore = "requires installed FFmpeg 7.x (run explicitly)"]
    async fn installed_ffmpeg_regression_for_each_category() {
        use std::process::Stdio;
        let fixtures: &[(&[&str], Kind)] = &[
            (&["-i", "pipe:0", "-f", "null", "-"], Kind::InputInvalid),
            (
                &[
                    "-c:v",
                    "rainsync_missing_decoder",
                    "-i",
                    "pipe:0",
                    "-f",
                    "null",
                    "-",
                ],
                Kind::DecoderUnavailable,
            ),
            (
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=size=2x2:rate=1",
                    "-frames:v",
                    "1",
                    "-c:v",
                    "rainsync_missing_encoder",
                    "-f",
                    "null",
                    "-",
                ],
                Kind::EncoderUnavailable,
            ),
        ];
        for &(arguments, expected) in fixtures {
            let mut child = tokio::process::Command::new("ffmpeg")
                .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
                .args(arguments)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let stderr = child.stderr.take().unwrap();
            let supervision = async {
                let status = child.wait().await?;
                anyhow::ensure!(!status.success(), "fixture_unexpected_success");
                anyhow::bail!("fixture_nonzero_exit");
            };
            let (result, kind) =
                tokio::time::timeout(Duration::from_secs(5), observe(supervision, stderr))
                    .await
                    .unwrap();
            assert_eq!(result.unwrap_err().to_string(), "fixture_nonzero_exit");
            assert_eq!(kind, Some(expected));
        }
    }
}
