//! HTTP composition only. Keep route-local limits and outer middleware order.
use crate::*;

pub(super) fn router(app: App) -> Router {
    Router::new()
        .route(
            "/api/v1/admin/settings",
            get(admin_settings::get).patch(admin_settings::change),
        )
        .route("/api/v1/admin/plugins", get(plugins::catalog))
        .route("/api/v1/admin/plugins/audit", get(plugins::audit))
        .route(
            "/api/v1/admin/plugins/{id}",
            axum::routing::put(plugins::configure).delete(plugins::remove),
        )
        .route(
            "/api/v1/admin/plugins/{id}/rollback",
            post(plugins::rollback),
        )
        .route("/api/v1/media/{id}/plugin-metadata", get(plugins::metadata))
        .route(
            "/api/v1/libraries/{id}/sources",
            post(private_library::add_source),
        )
        .route(
            "/api/v1/libraries/{id}/sources/{source}",
            get(private_library::source_detail)
                .patch(private_library::update_source)
                .delete(private_library::remove_source),
        )
        .route(
            "/api/v1/libraries/{id}/attach-source",
            post(private_library::attach_source),
        )
        .route(
            "/api/v1/libraries/{id}/sources/{source}/scan",
            get(private_library::scan_status).post(private_library::scan),
        )
        .merge(control_cluster::routes())
        .merge(distributed_playback::routes())
        .merge(distributed_compute::routes())
        .merge(room_p2p::routes())
        .route(
            "/api/v1/rooms/{id}/timeline/current",
            get(timeline_chat::current),
        )
        .route(
            "/api/v1/rooms/{id}/timeline/activities",
            get(timeline_chat::activities),
        )
        .route(
            "/api/v1/rooms/{id}/timeline/messages",
            get(timeline_chat::messages).post(timeline_chat::post),
        )
        .route(
            "/api/v1/rooms/{id}/timeline/reactions",
            get(timeline_chat::reactions).post(timeline_chat::react),
        )
        .route(
            "/api/v1/rooms/{id}/timeline/moderation",
            post(timeline_chat::moderate),
        )
        .route(
            "/api/v1/rooms/{id}/timeline/audit",
            get(timeline_chat::audit),
        )
        .route(
            "/api/v1/libraries",
            get(private_library::list).post(private_library::create),
        )
        .route(
            "/api/v1/libraries/issued-shares",
            get(private_library::issued_shares),
        )
        .route(
            "/api/v1/libraries/{id}",
            get(private_library::detail)
                .put(private_library::rename)
                .delete(private_library::remove),
        )
        .route(
            "/api/v1/libraries/{id}/grants",
            post(private_library::grant),
        )
        .route(
            "/api/v1/libraries/{id}/grants/{target}",
            axum::routing::delete(private_library::revoke),
        )
        .route(
            "/api/v1/libraries/{id}/transfer",
            post(private_library::transfer),
        )
        .route(
            "/api/v1/libraries/{id}/room-shares",
            post(private_library::share),
        )
        .route(
            "/api/v1/libraries/{id}/room-shares/{grant}",
            axum::routing::delete(private_library::revoke_share)
                .patch(private_library::update_share),
        )
        .route("/api/v1/libraries/{id}/media", get(private_library::media))
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .route(
            "/api/v1/deployment/health",
            get(|| async {
                (
                    [(header::CACHE_CONTROL, "no-store")],
                    Json(json!({"service":"rainsync-server","live":true})),
                )
            }),
        )
        .route(
            "/api/v1/deployment/static-hls-contract",
            post(static_hls_contract::endpoint),
        )
        .route("/api/v1/auth/login", post(login))
        .route(
            "/api/v1/auth/registration-policy",
            get(admin_settings::registration_policy),
        )
        .route(
            "/api/v1/auth/registration-invites/validate",
            post(registration_auth::validate),
        )
        .route("/api/v1/auth/register", post(registration_auth::register))
        .route("/api/v1/auth/me", get(me))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/users", post(users))
        .route(
            "/api/v1/users/me/deletion",
            get(account_exit::preview).post(account_exit::delete),
        )
        .route(
            "/api/v1/users/me/profile",
            get(profile::get_profile).patch(profile::update),
        )
        .route(
            "/api/v1/users/me/avatar",
            axum::routing::put(avatars::upload).delete(avatars::remove),
        )
        .route("/api/v1/users/{id}/avatar", get(avatars::read))
        .route(
            "/api/v1/admin/registration-invites",
            get(registration::list).post(registration::create),
        )
        .route(
            "/api/v1/admin/registration-invites/{id}",
            delete(registration::revoke),
        )
        .route("/api/v1/rooms/{id}/guest-session", post(guests::enter))
        .route(
            "/api/v1/rooms/{id}/guest-access",
            get(guests::access).put(guests::set_access),
        )
        .route("/api/v1/rooms", get(rooms::list).post(rooms::create))
        .route("/api/v1/rooms/{id}/permissions", get(rooms::permissions))
        .route(
            "/api/v1/rooms/{id}/permissions/{user}",
            axum::routing::put(rooms::set_permissions).delete(rooms::revoke_permissions),
        )
        .route("/api/v1/rooms/{id}/members/{user}", delete(rooms::kick))
        .route(
            "/api/v1/rooms/{id}/platform-media",
            post(native_platform::create),
        )
        .route(
            "/api/v1/rooms/{room}/platform-media/preview",
            post(platform_import::preview).layer(axum::extract::DefaultBodyLimit::max(24 * 1024)),
        )
        .route(
            "/api/v1/rooms/{room}/platform-media/batch",
            post(platform_import::batch).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/v1/rooms/{room}/media/{media}",
            get(native_platform::scoped_detail),
        )
        .route(
            "/api/v1/platform-accounts/bilibili",
            get(platform_accounts::status).delete(platform_accounts::unlink),
        )
        .route(
            "/api/v1/platform-accounts/bilibili/check",
            post(platform_accounts::check_login).layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/v1/platform-accounts/bilibili/login",
            post(platform_accounts::start_login),
        )
        .route(
            "/api/v1/platform-accounts/bilibili/login/{id}/poll",
            post(platform_accounts::poll_login),
        )
        .route(
            "/api/v1/platform-accounts/bilibili/login/{id}",
            delete(platform_accounts::cancel_login),
        )
        .route(
            "/api/v1/platform-accounts/youtube",
            get(platform_accounts::youtube_status)
                .delete(platform_accounts::unlink_youtube)
                .layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/v1/platform-accounts/youtube/credential",
            axum::routing::put(platform_accounts::import_youtube_credential)
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/v1/platform-accounts/{provider}",
            get(platform_accounts::short_status)
                .delete(platform_accounts::unlink_short)
                .layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/credential",
            axum::routing::put(platform_accounts::import_short_credential)
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth",
            get(platform_accounts::oauth::status).delete(platform_accounts::oauth::unlink),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/login",
            post(platform_accounts::oauth::start),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/login/{id}",
            get(platform_accounts::oauth::read_login).delete(platform_accounts::oauth::cancel),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/login/{id}/poll",
            post(platform_accounts::oauth::poll),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/callback",
            get(platform_accounts::oauth::callback),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/claim",
            post(platform_accounts::oauth::claim),
        )
        .route(
            "/api/v1/platform-accounts/{provider}/oauth/renewal",
            axum::routing::put(platform_accounts::oauth::set_renewal),
        )
        .route(
            "/api/v1/platform-accounts/bilibili/renewal",
            get(platform_accounts::renewal::status).put(platform_accounts::renewal::set_preference),
        )
        .route(
            "/api/v1/playback-sessions/local-hls-ladder",
            post(media::playback_local_hls_ladder),
        )
        .route(
            "/api/v1/playback-sessions/advanced-local",
            post(media::advanced_local_playback),
        )
        .route(
            "/api/v1/playback-sessions/native-platform-compatibility",
            post(platform_media::prepare_compatibility),
        )
        .route(
            "/api/v1/playback-sessions/native-platform",
            post(platform_media::prepare),
        )
        .route(
            "/api/v1/platform-live-delivery/{session}/playlist.m3u8",
            get(native_live::playlist),
        )
        .route(
            "/api/v1/platform-other-live-delivery/{session}/playlist.m3u8",
            get(native_other_live::playlist),
        )
        .route(
            "/api/v1/platform-other-live-delivery/{session}/segments/{key}",
            get(native_other_live::segment),
        )
        .route(
            "/api/v1/platform-live-delivery/{session}/segments/{key}",
            get(native_live::segment),
        )
        .route(
            "/api/v1/internal/native-platform-input/{id}/{key}",
            get(platform_media::transcode::internal_input),
        )
        .route(
            "/api/v1/platform-delivery/{id}/compatibility/{*path}",
            get(platform_media::transcode::public_output),
        )
        .route(
            "/api/v1/platform-delivery/{session}/manifest.mpd",
            get(platform_media::manifest),
        )
        .route(
            "/api/v1/platform-delivery/{session}/text/catalog",
            get(native_platform_text::catalog),
        )
        .route(
            "/api/v1/platform-live-delivery/{session}/text/catalog",
            get(native_live::text_catalog),
        )
        .route(
            "/api/v1/platform-live-delivery/{session}/text/danmaku",
            get(native_live::text_history),
        )
        .route(
            "/api/v1/platform-live-delivery/{session}/text/realtime",
            get(native_live::text_realtime),
        )
        .route(
            "/api/v1/platform-delivery/{session}/text/subtitles/{id}",
            get(native_platform_text::subtitle),
        )
        .route(
            "/api/v1/platform-delivery/{session}/text/danmaku",
            get(native_platform_text::danmaku),
        )
        .route(
            "/api/v1/platform-delivery/{session}/tracks/{key}",
            get(platform_media::track),
        )
        .route("/api/v1/rooms/{id}/members", get(room_ownership::members))
        .route(
            "/api/v1/admin/rooms/{id}/diagnostics",
            get(room_diagnostics::export),
        )
        .route("/api/v1/rooms/{id}/owner", post(room_ownership::transfer))
        .route("/api/v1/rooms/{id}/lifecycle", get(room_lifecycle::status))
        .route("/api/v1/rooms/{id}/close", post(room_lifecycle::close))
        .route(
            "/api/v1/rooms/{id}/cleanup/retry",
            post(room_lifecycle::retry_cleanup),
        )
        .route("/api/v1/rooms/{id}/reopen", post(room_lifecycle::reopen))
        .route("/api/v1/rooms/{id}/archive", post(room_lifecycle::archive))
        .route("/api/v1/rooms/{id}/join", post(rooms::join))
        .route(
            "/api/v1/rooms/{id}/invites",
            get(rooms::list_invites).post(rooms::invite),
        )
        .route(
            "/api/v1/rooms/{id}/invites/{token}",
            delete(rooms::revoke_invite),
        )
        .route(
            "/api/v1/rooms/{id}/playlist",
            get(rooms::playlist).post(rooms::add_playlist),
        )
        .route(
            "/api/v1/rooms/{id}/playlist/{item}",
            delete(rooms::remove_playlist),
        )
        .route("/api/v1/rooms/{id}/messages", get(rooms::messages))
        .route(
            "/api/v1/sources",
            get(media::sources).post(media::add_source),
        )
        .route(
            "/api/v1/sources/{id}",
            get(source_settings::get)
                .patch(source_settings::change)
                .delete(media::remove_source),
        )
        .route("/api/v1/sources/{id}/test", post(media::scan))
        .route(
            "/api/v1/sources/{id}/access-policy",
            post(source_access::change),
        )
        .route("/api/v1/media", get(media::library))
        .route("/api/v1/media/browse", get(media_browse::browse))
        .route(
            "/api/v1/media/previews",
            get(media_previews::status).post(media_previews::request),
        )
        .route("/api/v1/media/{id}/cover", get(media_previews::image))
        .route("/api/v1/media/{id}", get(media_titles::detail))
        .route(
            "/api/v1/media/{id}/personal-title",
            axum::routing::put(media_titles::personal),
        )
        .route(
            "/api/v1/admin/media/{id}/shared-title",
            axum::routing::put(media_titles::shared),
        )
        .route(
            "/api/v1/playback-candidates",
            post(playback_capabilities::candidates),
        )
        .route(
            "/api/v1/playback-static-hls-capabilities",
            post(static_hls_availability::endpoint),
        )
        .route("/api/v1/playback-sessions", post(media::playback))
        .route(
            "/api/v1/upstream-profile-candidates",
            post(upstream_profiles::candidates).layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/v1/playback-sessions/upstream-profile",
            post(media::upstream_profile_playback)
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/v1/playback-sessions/http-file-continuation",
            post(media::http_file_continuation),
        )
        .route(
            "/api/v1/playback-requests/{key}",
            delete(playback_requests::cancel),
        )
        .route(
            "/api/v1/playback-sessions/{id}",
            get(media::readiness).delete(media::stop).post(media::renew),
        )
        .route(
            "/api/v1/playback-sessions/{id}/observations",
            post(playback_observations::observe),
        )
        .route(
            "/api/v1/playback-sessions/{id}/metrics",
            post(playback_metrics::endpoint).layer(axum::extract::DefaultBodyLimit::max(4096)),
        )
        .route("/api/v1/agents", get(agents::list).post(agents::create))
        .route("/api/v1/agents/pair", post(agents::pair))
        .route(
            "/api/v1/agents/{id}",
            axum::routing::put(agents::update).delete(agents::revoke),
        )
        .route("/api/v1/agents/{id}/scan", post(agents::scan))
        .route("/api/v1/agents/ws", get(agents::connect))
        .route("/api/v1/agents/drain-ws", get(agent_drain::connect))
        .route("/api/v1/ws", get(ws))
        .route("/api/v1/metrics", get(metrics::endpoint))
        .layer(axum::extract::DefaultBodyLimit::max(65536))
        .route("/ready", get(health::endpoint))
        .route("/api/v1/deployment/ready", get(health::endpoint))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            control_cluster::middleware,
        ))
        .layer(axum::middleware::from_fn(http_api::errors))
        .with_state(app)
}
