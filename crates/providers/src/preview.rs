use super::*;
pub struct Targets {
    pub posters: Vec<String>,
    pub video: String,
    pub headers: std::collections::BTreeMap<String, String>,
}
pub async fn targets(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    metadata: &Value,
) -> Result<Targets> {
    let kind = UpstreamKind::parse(kind);
    let base = validate_url(&format!("{}/", config.url.trim_end_matches('/')))?;
    let mut headers = config.headers.clone();
    headers.insert(
        if kind == Some(UpstreamKind::Jellyfin) {
            "Authorization"
        } else {
            "X-Emby-Token"
        }
        .into(),
        if kind == Some(UpstreamKind::Jellyfin) {
            format!("MediaBrowser Token=\"{}\"", config.token)
        } else {
            config.token.clone()
        },
    );
    let mut posters = vec![];
    for (image, tag) in [
        ("Backdrop", metadata["BackdropImageTags"][0].as_str()),
        ("Primary", metadata["ImageTags"]["Primary"].as_str()),
    ] {
        if let Some(tag) = tag {
            let mut url = base.clone();
            url.path_segments_mut()
                .map_err(|_| anyhow::anyhow!("invalid_base"))?
                .pop_if_empty()
                .extend(["Items", item, "Images", image, "0"]);
            url.query_pairs_mut().append_pair("tag", tag);
            posters.push(url.to_string());
        }
    }
    let mut video = base.clone();
    video
        .path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid_base"))?
        .pop_if_empty()
        .extend(["Videos", item, "stream.mp4"]);
    video.query_pairs_mut().append_pair("Static", "true");
    Ok(Targets {
        posters,
        video: video.to_string(),
        headers,
    })
}
