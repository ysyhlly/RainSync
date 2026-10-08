//! Public metadata only: never resolve signed playback, use a viewer Cookie,
//! generate login state or open media bytes during a single-link preview.
use base64::{Engine, engine::general_purpose::STANDARD};
use providers::platform::{bilibili, imports};
use serde_json::Value;
use std::io::Cursor;
use tokio::time::{Duration, Instant};

static DECODERS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));

fn validated_cover(response: bilibili::cover::CoverResponse) -> Option<String> {
    if response.body.is_empty() || response.body.len() > bilibili::cover::MAX_COVER_BYTES {
        return None;
    }
    let format = image::guess_format(&response.body).ok()?;
    let mime = match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::WebP => "image/webp",
        _ => return None,
    };
    if response.content_type != mime {
        return None;
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(&response.body), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().ok()?;
    // Normalize after bounded real decoding: strip metadata/animation and send
    // a small ordinary JPEG instead of a provider CDN address or original blob.
    let thumbnail = if decoded.width() > 512 || decoded.height() > 512 {
        decoded.thumbnail(512, 512).to_rgb8()
    } else {
        decoded.to_rgb8()
    };
    let mut output = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 80)
        .encode_image(&thumbnail)
        .ok()?;
    if output.len() > bilibili::cover::MAX_COVER_BYTES {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(output)
    ))
}

pub(super) fn is_ugc(reference: &imports::Reference) -> bool {
    reference.provider == imports::Provider::Bilibili
        && bilibili::parse_resource(&reference.url).is_ok()
}

pub(super) async fn enrich<T: bilibili::Transport + bilibili::cover::Transport + Clone>(
    transport: T,
    reference: &imports::Reference,
    item: &mut Value,
    deadline: Instant,
) {
    if !is_ugc(reference) {
        return;
    }
    let deadline = deadline.min(Instant::now() + Duration::from_secs(8));
    let metadata = async {
        let resource = bilibili::parse_resource(&reference.url)?;
        bilibili::Client::new(transport.clone(), None)
            .view_preview(&resource, deadline)
            .await
    }
    .await;
    match metadata {
        Ok(preview) => {
            let metadata = preview.metadata;
            item["title"] = Value::from(if metadata.part_count > 1 {
                format!("{} · {}", metadata.title, metadata.part_title)
            } else {
                metadata.title
            });
            let cover = async {
                let target = preview.cover?;
                let response =
                    tokio::time::timeout_at(deadline, transport.get_cover(&target, deadline))
                        .await
                        .ok()?
                        .ok()?;
                let permit = tokio::time::timeout_at(deadline, DECODERS.clone().acquire_owned())
                    .await
                    .ok()?
                    .ok()?;
                tokio::task::spawn_blocking(move || {
                    let _owner = permit;
                    validated_cover(response)
                })
                .await
                .ok()?
            }
            .await;
            if let Some(cover) = cover {
                item["cover_data_url"] = Value::from(cover);
            } else {
                item["cover_unavailable_reason"] =
                    Value::from("platform_preview_cover_unavailable");
            }
        }
        Err(error) => {
            item["metadata_error"] = super::import_failure(error);
            item["cover_unavailable_reason"] = Value::from("platform_preview_cover_unavailable");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
    };

    #[derive(Clone)]
    struct PublicView {
        seen: Arc<Mutex<Vec<bilibili::Endpoint>>>,
        body: Vec<u8>,
    }
    impl bilibili::cover::Transport for PublicView {
        fn get_cover<'a>(
            &'a self,
            _: &'a bilibili::cover::CoverUrl,
            _: Instant,
        ) -> Pin<
            Box<
                dyn Future<
                        Output = std::result::Result<
                            bilibili::cover::CoverResponse,
                            bilibili::Error,
                        >,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let mut body = Cursor::new(vec![]);
                image::DynamicImage::ImageRgb8(image::RgbImage::new(3, 2))
                    .write_to(&mut body, image::ImageFormat::Png)
                    .unwrap();
                Ok(bilibili::cover::CoverResponse {
                    content_type: "image/png".into(),
                    body: body.into_inner(),
                })
            })
        }
    }
    impl bilibili::Transport for PublicView {
        fn get<'a>(
            &'a self,
            request: bilibili::ApiRequest,
            _: Instant,
        ) -> Pin<
            Box<
                dyn Future<Output = std::result::Result<bilibili::ApiResponse, bilibili::Error>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                assert_eq!(request.endpoint(), bilibili::Endpoint::View);
                assert!(!request.headers().contains_key("Cookie"));
                self.seen.lock().unwrap().push(request.endpoint());
                Ok(bilibili::ApiResponse {
                    status: 200,
                    body: self.body.clone(),
                    set_cookie: vec![],
                })
            })
        }
    }
    fn fixture(pages: Value) -> Value {
        json!({"code":0,"data":{"bvid":"BV1GJ411x7h7","aid":1234,"state":0,"title":"真正的视频标题",
            "rights":{"pay":0,"ugc_pay":0,"arc_pay":0},"pages":pages,
            "pic":"https://external.example.invalid/never-expose-this-cover.jpg"}})
    }
    fn reference(part: u32) -> imports::Reference {
        match imports::parse_input(
            &format!("https://www.bilibili.com/video/BV1GJ411x7h7/?p={part}"),
            Some(imports::Provider::Bilibili),
        )
        .unwrap()
        {
            imports::Input::Video(reference) => reference,
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn ugc_metadata_preview_returns_only_decoded_normalized_cover_data() {
        let seen = Arc::new(Mutex::new(vec![]));
        let reference = reference(1);
        let mut item = super::super::reference_dto(&reference);
        let mut body = fixture(json!([{"cid":10,"page":1,"part":"第一段","duration":60}]));
        body["data"]["pic"] =
            json!("https://i2.hdslb.com/bfs/archive/0123456789abcdef0123456789abcdef01234567.png");
        enrich(
            PublicView {
                seen: seen.clone(),
                body: serde_json::to_vec(&body).unwrap(),
            },
            &reference,
            &mut item,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        let cover = item["cover_data_url"].as_str().unwrap();
        let bytes = STANDARD
            .decode(cover.strip_prefix("data:image/jpeg;base64,").unwrap())
            .unwrap();
        assert!(bytes.len() <= bilibili::cover::MAX_COVER_BYTES);
        assert_eq!(
            image::guess_format(&bytes).unwrap(),
            image::ImageFormat::Jpeg
        );
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
        assert!(item.get("cover_unavailable_reason").is_none());
        assert!(!item.to_string().contains("hdslb.com"));
        assert_eq!(*seen.lock().unwrap(), vec![bilibili::Endpoint::View]);
    }

    #[test]
    fn ugc_cover_decoder_enforces_type_dimensions_size_and_full_decode() {
        for (format, mime) in [
            (image::ImageFormat::Png, "image/png"),
            (image::ImageFormat::Jpeg, "image/jpeg"),
            (image::ImageFormat::WebP, "image/webp"),
        ] {
            let mut encoded = Cursor::new(vec![]);
            image::DynamicImage::ImageRgb8(image::RgbImage::new(2, 3))
                .write_to(&mut encoded, format)
                .unwrap();
            let encoded = encoded.into_inner();
            assert!(
                validated_cover(bilibili::cover::CoverResponse {
                    content_type: mime.into(),
                    body: encoded.clone()
                })
                .is_some()
            );
            assert!(
                validated_cover(bilibili::cover::CoverResponse {
                    content_type: "text/html".into(),
                    body: encoded
                })
                .is_none()
            );
        }
        let mut oversized_dimensions = Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(image::RgbImage::new(2049, 1))
            .write_to(&mut oversized_dimensions, image::ImageFormat::Png)
            .unwrap();
        for body in [
            oversized_dimensions.into_inner(),
            vec![0; bilibili::cover::MAX_COVER_BYTES + 1],
            b"\x89PNG\r\n\x1a\nmalformed".to_vec(),
        ] {
            assert!(
                validated_cover(bilibili::cover::CoverResponse {
                    content_type: "image/png".into(),
                    body
                })
                .is_none()
            );
        }
    }
    #[tokio::test]
    async fn ugc_metadata_preview_reads_only_anonymous_view_and_preserves_part_identity() {
        let seen = Arc::new(Mutex::new(vec![]));
        let reference = reference(2);
        let mut item = super::super::reference_dto(&reference);
        let key = item["key"].clone();
        let body = fixture(json!([
            {"cid":10,"page":1,"part":"第一段","duration":60},
            {"cid":20,"page":2,"part":"第二段","duration":90},
        ]));
        enrich(
            PublicView {
                seen: seen.clone(),
                body: serde_json::to_vec(&body).unwrap(),
            },
            &reference,
            &mut item,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        assert_eq!(item["title"], "真正的视频标题 · 第二段");
        assert_eq!(item["part"], 2);
        assert_eq!(item["key"], key);
        assert_eq!(
            item["cover_unavailable_reason"],
            "platform_preview_cover_unavailable"
        );
        assert_eq!(*seen.lock().unwrap(), vec![bilibili::Endpoint::View]);
        assert!(!item.to_string().contains("external.example.invalid"));
        assert!(item.get("metadata_error").is_none());
    }
    #[tokio::test]
    async fn ugc_metadata_preview_keeps_single_part_title_and_safe_failure_fallback() {
        for (body, expected_title, expected_error) in [
            (
                fixture(json!([{"cid":10,"page":1,"part":"第一段","duration":60}])),
                Some("真正的视频标题"),
                None,
            ),
            (
                json!({"code":-403,"message":"SECRET_UPSTREAM_DETAIL"}),
                None,
                Some("platform_import_platform_restricted"),
            ),
        ] {
            let reference = reference(1);
            let mut item = super::super::reference_dto(&reference);
            enrich(
                PublicView {
                    seen: Default::default(),
                    body: serde_json::to_vec(&body).unwrap(),
                },
                &reference,
                &mut item,
                Instant::now() + Duration::from_secs(2),
            )
            .await;
            assert_eq!(item["title"].as_str(), expected_title);
            assert_eq!(item["metadata_error"]["code"].as_str(), expected_error);
            assert_eq!(item["url"], reference.url);
            assert!(!item.to_string().contains("SECRET_UPSTREAM_DETAIL"));
        }
        // An expired original budget produces a recoverable hint, no transport
        // call, and retains the canonical selectable reference.
        let seen = Arc::new(Mutex::new(vec![]));
        let reference = reference(1);
        let mut item = super::super::reference_dto(&reference);
        enrich(
            PublicView {
                seen: seen.clone(),
                body: vec![],
            },
            &reference,
            &mut item,
            Instant::now(),
        )
        .await;
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(item["metadata_error"]["code"], "platform_import_deadline");
        assert_eq!(item["metadata_error"]["retryable"], true);
    }
}
