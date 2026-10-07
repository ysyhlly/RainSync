use super::*;
use persistence::media_previews::{self, Attempt, Settings};
use std::time::Duration;

pub async fn run(app: App, settings: Settings, mut stop: tokio::sync::watch::Receiver<bool>) {
    let owner = Uuid::new_v4();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        if *stop.borrow() {
            break;
        }
        while tasks.len() < settings.concurrency {
            let claimed = tokio::select! {
                _ = process::stopped(&mut stop) => break,
                result = tokio::time::timeout(Duration::from_secs(2), media_previews::claim_with_limit(&app.db, owner, settings.queue_limit)) =>
                    result.unwrap_or_else(|_| Err(anyhow::anyhow!("preview_claim_timeout"))),
            };
            match claimed {
                Ok(Some(a)) => {
                    let app = app.clone();
                    let settings = settings.clone();
                    let stop = stop.clone();
                    tasks.spawn(async move { execute(app, settings, a, stop).await });
                }
                Ok(None) => break,
                Err(_) => {
                    tracing::warn!("preview claim failed");
                    break;
                }
            }
        }
        tokio::select! {_=process::stopped(&mut stop)=>break,_=tokio::time::sleep(Duration::from_millis(250))=>{},Some(_)=tasks.join_next(),if !tasks.is_empty()=>{}}
    }
    while tasks.join_next().await.is_some() {}
}
async fn resource(app: &App, a: &Attempt) -> anyhow::Result<(Value, Vec<String>)> {
    let row=sqlx::query("SELECT m.resource,m.metadata,m.source_version,s.kind,s.config_encrypted FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.preview_generation=$2 AND m.available")
        .bind(a.media_id).bind(a.generation).fetch_one(&app.db).await?;
    let config: providers::SourceConfig =
        serde_json::from_value(decrypt(app, &row.get::<String, _>("config_encrypted"))?)?;
    let kind: String = row.get("kind");
    let item: String = row.get("resource");
    let mut resource = json!({"kind":kind,"resource":item,"root":config.root,"url":config.url,"headers":config.headers,"source_url":config.url,"access_policy":config.access_policy});
    let mut posters = vec![];
    match kind.as_str() {
        "local" => {
            let file = media_core::open_local_file(std::path::Path::new(&config.root), &item)?;
            resource["read_version"] =
                json!(media_core::file_version::snapshot_file(&file)?.version);
        }
        "agent" => {
            resource["agent_id"] = json!(config.agent_id);
            resource["source_version"] = json!(row.get::<Option<String>, _>("source_version"));
        }
        "jellyfin" | "emby" => {
            let targets = providers::preview::targets(
                &kind,
                &config,
                &item,
                &row.get::<Value, _>("metadata"),
            )
            .await?;
            resource["url"] = json!(targets.video);
            resource["headers"] = json!(targets.headers);
            posters = targets.posters;
        }
        "http" => {}
        _ => anyhow::bail!("unsupported_preview"),
    }
    Ok((resource, posters))
}
async fn execute(
    app: App,
    settings: Settings,
    a: Attempt,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(settings.timeout_seconds);
    let result = tokio::select! {
        _ = process::stopped(&mut stop) => return,
        result = tokio::time::timeout_at(deadline, resource(&app, &a)) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("preview_timeout"))),
    };
    let Ok((resource, posters)) = result else {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            media_previews::finish(&app.db, &a, None, true, settings.cache_bytes),
        )
        .await;
        return;
    };
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    let (grant, lifecycle) = preview_input::register(
        &app,
        a.clone(),
        resource.clone(),
        settings.input_bytes,
        cancel.clone(),
    );
    let produce = async {
        for target in posters.iter().chain(std::iter::once(
            &resource["url"].as_str().unwrap_or("").to_owned(),
        )) {
            if *receiver.borrow() {
                anyhow::bail!("preview_cancelled")
            }
            let poster = posters.contains(target);
            let key = grant.target(target.clone());
            let url = preview_input::url(a.attempt_id, key)?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match media_core::preview::generate(
                &url,
                poster,
                !matches!(resource["kind"].as_str(), Some("local" | "agent")),
                remaining,
                receiver.clone(),
            )
            .await
            {
                Ok(bytes) => return Ok(bytes),
                Err(_) if poster => continue,
                Err(e) => return Err(e),
            }
        }
        anyhow::bail!("preview_unavailable")
    };
    let mut renewal = tokio::time::interval(Duration::from_secs(5));
    // Keep renewal inside a future polled by the supervisor. Database lock or
    // pool waits must never suspend timeout, shutdown or FFmpeg supervision.
    let renew = async {
        loop {
            renewal.tick().await;
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), media_previews::renew(&app.db, &a))
                    .await,
                Ok(Ok(true))
            ) {
                break;
            }
        }
    };
    let result = supervise_preview(produce, renew, deadline, &mut stop, || lifecycle.stop()).await;
    lifecycle.stop();
    // Check the actual reading-side file again; host/container stat identities
    // differ, so a server-side stamp is not presented as a content hash.
    let unchanged = if resource["kind"] == "local" {
        media_core::open_local_file(
            std::path::Path::new(resource["root"].as_str().unwrap_or("")),
            resource["resource"].as_str().unwrap_or(""),
        )
        .ok()
        .and_then(|f| media_core::file_version::snapshot_file(&f).ok())
        .is_some_and(|v| resource["read_version"] == v.version)
    } else {
        true
    };
    let image = result.ok().filter(|_| unchanged && !*stop.borrow());
    let digest = image.as_ref().map(|v| hex::encode(Sha256::digest(v)));
    if !matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            media_previews::finish(
                &app.db,
                &a,
                image.as_deref().zip(digest.as_deref()),
                image.is_none(),
                settings.cache_bytes,
            )
        )
        .await,
        Ok(Ok(_))
    ) {
        tracing::warn!("preview publication failed")
    }
}

async fn supervise_preview<T>(
    produce: impl std::future::Future<Output = T>,
    renew: impl std::future::Future<Output = ()>,
    deadline: tokio::time::Instant,
    stop: &mut tokio::sync::watch::Receiver<bool>,
    cancel: impl FnOnce(),
) -> T {
    tokio::pin!(produce, renew);
    tokio::select! {
        result = &mut produce => result,
        _ = async {
            tokio::select! {
                _ = process::stopped(stop) => (),
                _ = tokio::time::sleep_until(deadline) => (),
                _ = &mut renew => (),
            }
        } => { cancel(); produce.await },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_database_observation_does_not_block_producer_deadline_or_stop() {
        for shutdown in [false, true] {
            let (cancel, mut producer_stop) = tokio::sync::watch::channel(false);
            let (stop, mut stopped) = tokio::sync::watch::channel(false);
            let produce = async move {
                producer_stop.changed().await.unwrap();
                assert!(*producer_stop.borrow());
                "drained"
            };
            if shutdown {
                stop.send_replace(true);
            }
            let result = tokio::time::timeout(
                Duration::from_secs(1),
                supervise_preview(
                    produce,
                    std::future::pending(),
                    tokio::time::Instant::now() + Duration::from_millis(20),
                    &mut stopped,
                    || {
                        cancel.send_replace(true);
                    },
                ),
            )
            .await
            .unwrap();
            assert_eq!(result, "drained");
        }
        let (_, mut stopped) = tokio::sync::watch::channel(false);
        let result = supervise_preview(
            std::future::ready("produced"),
            std::future::pending(),
            tokio::time::Instant::now() + Duration::from_secs(1),
            &mut stopped,
            || panic!("successful producer cannot be interrupted by a pending DB wait"),
        )
        .await;
        assert_eq!(result, "produced");
    }
}
