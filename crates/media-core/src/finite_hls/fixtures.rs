//! Actual owned generated media fixtures, never platform/user recordings.
use super::*;
use anyhow::Result;
use std::time::Duration;
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("rainsync-finite-hls-{}", uuid::Uuid::new_v4()))
}
async fn generate(path: &std::path::Path, audio: bool) -> Result<()> {
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    crate::input_policy::clean_environment(&mut command);
    command.args([
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30",
    ]);
    if audio {
        command.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]);
    }
    command.args([
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
    ]);
    if audio {
        command.args(["-c:a", "aac", "-ar", "48000", "-ac", "1"]);
    } else {
        command.arg("-an");
    }
    command.args(["-f", "mpegts"]).arg(path);
    let (status, _) =
        crate::child_process::capture(command, Duration::from_secs(20), 65536).await?;
    anyhow::ensure!(status.success(), "owned_fixture_generation_failed");
    Ok(())
}
#[tokio::test]
async fn actual_clear_ts_reset_is_physically_mapped_and_redecoded() {
    let dir = root();
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("source.ts");
    let scope = crate::child_process::Scope::new();
    scope.run(async {
        generate(&file,false).await.unwrap();let bytes=std::fs::read(&file).unwrap();
        let proof=decode_transport_stream(&bytes,2.0).await.unwrap();assert_eq!(proof.video_frames(),60);
        let mut map=TimestampMap::default();
        let first=normalize_transport_stream(&bytes,&proof,false,&mut map).unwrap();
        let second=normalize_transport_stream(&bytes,&proof,true,&mut map).unwrap();
        assert_eq!(first.mapping.normalized_video_first_pts,90000);
        assert_eq!(second.mapping.normalized_video_first_pts,270000);
        assert_eq!(second.mapping.original_video_first_pts,first.mapping.original_video_first_pts);
        assert_ne!(second.mapping.original_sha256,second.mapping.normalized_sha256);
        let decoded=decode_transport_stream(&second.bytes,2.0).await.unwrap();assert_eq!(decoded.first_video_pts(),270000);
        let mut both=first.bytes;both.extend(second.bytes);
        let all=decode_transport_stream(&both,4.0).await.unwrap();assert_eq!(all.video_frames(),120);assert_eq!(all.first_video_pts(),90000);
        let mut unmarked=TimestampMap::default();normalize_transport_stream(&bytes,&proof,false,&mut unmarked).unwrap();
        let old_count=unmarked.mappings.len();assert!(normalize_transport_stream(&bytes,&proof,false,&mut unmarked).is_err());assert_eq!(unmarked.mappings.len(),old_count);
        assert!(decode_transport_stream(&bytes,3.0).await.is_err());
        let mut altered=bytes.clone();altered[0]=0;assert!(normalize_transport_stream(&altered,&proof,false,&mut TimestampMap::default()).is_err());
        let master=parse_master("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=160x90,FRAME-RATE=30.000,CODECS=\"avc1.64000a\"\nowned.m3u8\n").unwrap();
        assert_eq!(master.selected().unwrap().width,proof.width());
    }).await;
    scope.shutdown().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn actual_aac_offset_is_retained_and_unproved_reset_refused() {
    let dir = root();
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("source.ts");
    let scope = crate::child_process::Scope::new();
    scope
        .run(async {
            generate(&file, true).await.unwrap();
            let bytes = std::fs::read(&file).unwrap();
            let proof = decode_transport_stream(&bytes, 2.0).await.unwrap();
            assert!(proof.has_audio());
            let mut map = TimestampMap::default();
            let first = normalize_transport_stream(&bytes, &proof, false, &mut map).unwrap();
            let m = &first.mapping;
            assert_eq!(
                m.original_audio_first_pts.unwrap() - m.original_video_first_pts,
                m.normalized_audio_first_pts.unwrap() - m.normalized_video_first_pts
            );
            decode_transport_stream(&first.bytes, 2.0).await.unwrap();
            let input = owned(&first.bytes, dir.join("normalized.ts"));
            let output = dir.join("origin-output");
            std::fs::create_dir(&output).unwrap();
            let mut args = crate::hls_args(
                &input.decoder_path().unwrap(),
                output.join("index.m3u8").to_str().unwrap(),
                0.0,
                true,
                None,
            );
            constrain_hls_recipe(&mut args, 1.0, 0.0, 2.0, 30.0).unwrap();
            crate::input_policy::constrain(&mut args, false, false);
            let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
            crate::input_policy::clean_environment(&mut command);
            command.args(args);
            input.install(&mut command).unwrap();
            let (status, _) =
                crate::child_process::capture(command, Duration::from_secs(20), 65536)
                    .await
                    .unwrap();
            assert!(status.success());
            let playlist = parse_media(
                &std::fs::read_to_string(output.join("index.m3u8"))
                    .unwrap()
                    .replace("PLAYLIST-TYPE:EVENT", "PLAYLIST-TYPE:VOD"),
            )
            .unwrap();
            let init = std::fs::read(output.join(playlist.map.as_deref().unwrap())).unwrap();
            let mut normalizer = Fmp4Normalizer::new(&playlist, &init).unwrap();
            let mut all = init;
            for segment in &playlist.segments {
                all.extend(
                    normalizer
                        .ingest(&std::fs::read(output.join(&segment.uri)).unwrap(), false)
                        .unwrap(),
                );
            }
            let output_input = owned(&all, output.join("qualified.mp4"));
            let decoded = decode_fmp4_owned(&output_input).await.unwrap();
            let output_proof = normalizer.inspect_probe(&decoded).unwrap();
            assert_eq!(output_proof.duration_ms, 2000.0);
            assert_eq!(
                output_proof
                    .tracks
                    .iter()
                    .find(|t| t.kind == crate::static_hls::timeline::TrackKind::Video)
                    .unwrap()
                    .decoded_first_pts,
                0
            );
            assert_eq!(
                output_proof
                    .tracks
                    .iter()
                    .find(|t| t.kind == crate::static_hls::timeline::TrackKind::Audio)
                    .unwrap()
                    .decoded_first_pts,
                0
            );
            assert!(
                normalize_transport_stream(&bytes, &proof, true, &mut map).is_err(),
                "independent AAC priming/tail overlap must not become scalar proof"
            );
        })
        .await;
    scope.shutdown().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

async fn generate_fmp4(directory: &std::path::Path, audio: bool) -> Result<()> {
    let mut command = tokio::process::Command::new("/usr/bin/ffmpeg");
    crate::input_policy::clean_environment(&mut command);
    command.args([
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30",
    ]);
    if audio {
        command.args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]);
    }
    command.args([
        "-t",
        "4",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
    ]);
    if audio {
        command.args(["-c:a", "aac", "-ar", "48000", "-ac", "1"]);
    } else {
        command.arg("-an");
    }
    command
        .args([
            "-avoid_negative_ts",
            "disabled",
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_segment_type",
            "fmp4",
            "-hls_playlist_type",
            "vod",
        ])
        .arg(directory.join("index.m3u8"));
    let (status, _) =
        crate::child_process::capture(command, Duration::from_secs(20), 65536).await?;
    anyhow::ensure!(status.success(), "owned_fmp4_fixture_generation_failed");
    Ok(())
}
fn owned(bytes: &[u8], path: std::path::PathBuf) -> crate::advanced_media::OwnedLocalInput {
    std::fs::write(&path, bytes).unwrap();
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o400)).unwrap();
    crate::advanced_media::OwnedLocalInput::materialized_retained(
        std::fs::File::open(&path).unwrap(),
        path,
    )
    .unwrap()
}
#[tokio::test]
async fn actual_fmp4_true_reset_preserves_samples_and_reuses_full_timeline_proof() {
    let dir = root();
    std::fs::create_dir(&dir).unwrap();
    let scope = crate::child_process::Scope::new();
    scope.run(async {
        generate_fmp4(&dir,false).await.unwrap();let source=parse_media(&std::fs::read_to_string(dir.join("index.m3u8")).unwrap()).unwrap();
        let init=std::fs::read(dir.join(source.map.as_deref().unwrap())).unwrap();
        let fragment=std::fs::read(dir.join(&source.segments[0].uri)).unwrap();
        let source=parse_media("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\na.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.m4s\n#EXT-X-ENDLIST\n").unwrap();
        let mut normalizer=Fmp4Normalizer::new(&source,&init).unwrap();let first=normalizer.ingest(&fragment,false).unwrap();let second=normalizer.ingest(&fragment,true).unwrap();
        let second_mapping=&normalizer.mappings[1];assert_eq!(second_mapping.tracks[0].original_first_pts,0);assert_eq!(second_mapping.tracks[0].normalized_first_pts,30720);
        assert_ne!(second_mapping.original_sha256,second_mapping.normalized_sha256);
        let mut all=init.clone();all.extend(first);all.extend(second);let input=owned(&all,dir.join("normalized.mp4"));
        let probe=decode_fmp4_owned(&input).await.unwrap();let proof=normalizer.inspect_probe(&probe).unwrap();
        assert_eq!(proof.duration_ms,4000.0);assert_eq!(proof.tracks[0].decoded_frames,120);assert_eq!(proof.source_origin_ms,0);
        let mut unmarked=Fmp4Normalizer::new(&source,&init).unwrap();unmarked.ingest(&fragment,false).unwrap();assert!(unmarked.ingest(&fragment,false).is_err());assert_eq!(unmarked.mappings.len(),1);
        let mut changed=fragment.clone();let tfhd=changed.windows(4).position(|b|b==b"tfhd").unwrap();changed[tfhd+11]^=1;
        assert!(Fmp4Normalizer::new(&source,&init).unwrap().ingest(&changed,false).is_err());
        // The same normalized descriptor uses the established HLS recipe.
        let out=dir.join("output");std::fs::create_dir(&out).unwrap();let mut command=tokio::process::Command::new("/usr/bin/ffmpeg");
        crate::input_policy::clean_environment(&mut command);let mut args=crate::hls_args(&input.decoder_path().unwrap(),out.join("index.m3u8").to_str().unwrap(),0.0,true,None);
        crate::input_policy::constrain(&mut args,false,false);command.args(args).arg("-v").arg("error");input.install(&mut command).unwrap();
        let (status,_)=crate::child_process::capture(command,Duration::from_secs(20),65536).await.unwrap();assert!(status.success());
        let output_text=std::fs::read_to_string(out.join("index.m3u8")).unwrap().replace("PLAYLIST-TYPE:EVENT","PLAYLIST-TYPE:VOD");
        let output_playlist=parse_media(&output_text).unwrap();let mut output_normalizer=Fmp4Normalizer::new(&output_playlist,&std::fs::read(out.join(output_playlist.map.as_deref().unwrap())).unwrap()).unwrap();
        let mut output_bytes=std::fs::read(out.join(output_playlist.map.as_deref().unwrap())).unwrap();for s in &output_playlist.segments {output_bytes.extend(output_normalizer.ingest(&std::fs::read(out.join(&s.uri)).unwrap(),false).unwrap());}
        let output_input=owned(&output_bytes,out.join("qualified.mp4"));let output_probe=decode_fmp4_owned(&output_input).await.unwrap();let output_proof=output_normalizer.inspect_probe(&output_probe).unwrap();assert_eq!(output_proof.duration_ms,4000.0);assert_eq!(output_proof.tracks[0].decoded_frames,120);
    }).await;
    scope.shutdown().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn actual_muxed_fmp4_preserves_original_priming_and_continuous_audio() {
    let dir = root();
    std::fs::create_dir(&dir).unwrap();
    let scope = crate::child_process::Scope::new();
    scope
        .run(async {
            generate_fmp4(&dir, true).await.unwrap();
            let source =
                parse_media(&std::fs::read_to_string(dir.join("index.m3u8")).unwrap()).unwrap();
            let init = std::fs::read(dir.join(source.map.as_deref().unwrap())).unwrap();
            let mut normalizer = Fmp4Normalizer::new(&source, &init).unwrap();
            let mut all = init.clone();
            for segment in &source.segments {
                all.extend(
                    normalizer
                        .ingest(&std::fs::read(dir.join(&segment.uri)).unwrap(), false)
                        .unwrap(),
                );
            }
            let input = owned(&all, dir.join("normalized.mp4"));
            let probe = decode_fmp4_owned(&input).await.unwrap();
            let proof = normalizer.inspect_probe(&probe).unwrap();
            assert_eq!(proof.tracks.len(), 2);
            assert_eq!(proof.duration_ms, 4000.0);
            let audio = proof
                .tracks
                .iter()
                .find(|t| t.kind == crate::static_hls::timeline::TrackKind::Audio)
                .unwrap();
            assert_eq!(audio.raw_first_pts, -1024);
            assert_eq!(audio.decoded_first_pts, 0);
            assert_eq!(audio.priming_samples, 1024);
            let first = std::fs::read(dir.join(&source.segments[0].uri)).unwrap();
            let mut reset = Fmp4Normalizer::new(&source, &init).unwrap();
            reset.ingest(&first, false).unwrap();
            assert!(reset.ingest(&first, true).is_err());
        })
        .await;
    scope.shutdown().await.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
