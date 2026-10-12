//! Bounded signing-key reuse across preparations. Each request still owns its
//! exact Cookie and performs the usual account/login guards before and after
//! provider work; this registry stores no authorization or playback result.
use providers::platform::bilibili::{Client, Cookie, Transport, WbiKeyCache};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

const CAPACITY: usize = 256;
const LIFETIME: Duration = Duration::from_secs(1800);

/// A cache partition, never evidence of current account or login authority.
/// No cookies, media URLs, playback results or authorization verdicts are kept.
pub(crate) struct SigningScope<'a> {
    pub viewer: Uuid,
    pub login_hash: &'a str,
    pub account: Option<Uuid>,
    pub revision: Option<i64>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Scope {
    viewer: Uuid,
    login_hash: String,
    account: Option<Uuid>,
    revision: Option<i64>,
}

struct Entry {
    cache: Arc<WbiKeyCache>,
    expires: Instant,
    last_used: Instant,
}

#[derive(Default)]
pub(crate) struct Registry {
    entries: Mutex<HashMap<Scope, Entry>>,
}

impl Registry {
    /// Build a fresh request client with the current frozen credential. Only
    /// signing material is shared; a prior client's cookies/results cannot be
    /// reused by a new preparation, even in the same signing-key partition.
    pub(crate) async fn client_for_scope<T: Transport>(
        &self,
        scope: SigningScope<'_>,
        transport: T,
        cookie: Option<&Cookie>,
        deadline: Instant,
    ) -> Result<Client<T>, providers::platform::bilibili::Error> {
        let keys = self
            .for_scope(
                scope.viewer,
                scope.login_hash,
                scope.account,
                scope.revision,
                deadline,
            )
            .await?;
        Ok(Client::with_wbi_cache(transport, cookie.cloned(), keys))
    }

    async fn for_scope(
        &self,
        viewer: Uuid,
        login_hash: &str,
        account: Option<Uuid>,
        revision: Option<i64>,
        deadline: Instant,
    ) -> Result<Arc<WbiKeyCache>, providers::platform::bilibili::Error> {
        let mut entries = tokio::time::timeout_at(deadline, self.entries.lock())
            .await
            .map_err(|_| providers::platform::bilibili::Error::Deadline)?;
        let now = Instant::now();
        if now >= deadline {
            return Err(providers::platform::bilibili::Error::Deadline);
        }
        entries.retain(|_, entry| entry.expires > now);
        let scope = Scope {
            viewer,
            login_hash: login_hash.to_owned(),
            account,
            revision,
        };
        if let Some(entry) = entries.get_mut(&scope) {
            entry.last_used = now;
            return Ok(entry.cache.clone());
        }
        if entries.len() >= CAPACITY {
            // Keep active requests sharing their existing single-flight cache.
            // If all slots are busy, use a request-local cache rather than grow
            // retained state or evict a cache another resolver is using.
            let oldest_idle = entries
                .iter()
                .filter(|(_, entry)| Arc::strong_count(&entry.cache) == 1)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(scope, _)| scope.clone());
            if let Some(oldest) = oldest_idle {
                entries.remove(&oldest);
            } else {
                return Ok(Arc::new(WbiKeyCache::default()));
            }
        }
        let cache = Arc::new(WbiKeyCache::default());
        entries.insert(
            scope,
            Entry {
                cache: cache.clone(),
                expires: now + LIFETIME,
                last_used: now,
            },
        );
        Ok(cache)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::platform::bilibili::{ApiRequest, ApiResponse, Error};

    #[derive(Clone, Default)]
    struct CaptureCredentials(Arc<std::sync::Mutex<Vec<Option<String>>>>);

    impl Transport for CaptureCredentials {
        fn get<'a>(
            &'a self,
            request: ApiRequest,
            _deadline: Instant,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ApiResponse, Error>> + Send + 'a>,
        > {
            self.0
                .lock()
                .unwrap()
                .push(request.headers().get("Cookie").cloned());
            Box::pin(async { Err(Error::Transport) })
        }
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[tokio::test]
    async fn signing_partition_never_reuses_a_previous_preparation_credential_client() {
        let registry = Registry::default();
        let transport = CaptureCredentials::default();
        let viewer = Uuid::new_v4();
        let account = Uuid::new_v4();
        let first = Cookie::from_header("SESSDATA=synthetic-first; DedeUserID=1").unwrap();
        let second = Cookie::from_header("SESSDATA=synthetic-second; DedeUserID=1").unwrap();
        for cookie in [Some(&first), Some(&second), None] {
            let client = registry
                .client_for_scope(
                    SigningScope {
                        viewer,
                        login_hash: "synthetic-login",
                        account: Some(account),
                        revision: Some(1),
                    },
                    transport.clone(),
                    cookie,
                    deadline(),
                )
                .await
                .unwrap();
            assert!(matches!(
                client.nav(deadline()).await,
                Err(Error::Transport)
            ));
        }
        assert_eq!(
            *transport.0.lock().unwrap(),
            vec![
                Some(first.expose_for_storage().to_owned()),
                Some(second.expose_for_storage().to_owned()),
                None,
            ]
        );
        assert_eq!(registry.entries.lock().await.len(), 1);
        assert!(matches!(
            registry
                .client_for_scope(
                    SigningScope {
                        viewer,
                        login_hash: "synthetic-login",
                        account: Some(account),
                        revision: Some(1)
                    },
                    transport.clone(),
                    Some(&first),
                    Instant::now(),
                )
                .await,
            Err(Error::Deadline)
        ));
        assert_eq!(transport.0.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn signing_cache_reuses_only_the_exact_viewer_login_and_account_revision() {
        let registry = Registry::default();
        let viewer = Uuid::new_v4();
        let account = Uuid::new_v4();
        let first = registry
            .for_scope(viewer, "login-one", Some(account), Some(1), deadline())
            .await
            .unwrap();
        let again = registry
            .for_scope(viewer, "login-one", Some(account), Some(1), deadline())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        for (other_viewer, login, other_account, revision) in [
            (Uuid::new_v4(), "login-one", Some(account), Some(1)),
            (viewer, "login-two", Some(account), Some(1)),
            (viewer, "login-one", Some(Uuid::new_v4()), Some(1)),
            (viewer, "login-one", Some(account), Some(2)),
            (viewer, "login-one", None, None),
        ] {
            let other = registry
                .for_scope(other_viewer, login, other_account, revision, deadline())
                .await
                .unwrap();
            assert!(!Arc::ptr_eq(&first, &other));
        }
    }

    #[tokio::test]
    async fn signing_cache_expires_and_stays_bounded_with_active_requests() {
        let registry = Registry::default();
        let viewer = Uuid::new_v4();
        let first = registry
            .for_scope(viewer, "login-one", None, None, deadline())
            .await
            .unwrap();
        registry
            .entries
            .lock()
            .await
            .values_mut()
            .next()
            .unwrap()
            .expires = Instant::now();
        let refreshed = registry
            .for_scope(viewer, "login-one", None, None, deadline())
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &refreshed));
        let mut active = vec![refreshed.clone()];
        for _ in 1..CAPACITY {
            active.push(
                registry
                    .for_scope(Uuid::new_v4(), "login", None, None, deadline())
                    .await
                    .unwrap(),
            );
        }
        let uncached = registry
            .for_scope(Uuid::new_v4(), "overflow", None, None, deadline())
            .await
            .unwrap();
        assert_eq!(registry.entries.lock().await.len(), CAPACITY);
        assert_eq!(Arc::strong_count(&uncached), 1);
        let still_shared = registry
            .for_scope(viewer, "login-one", None, None, deadline())
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&refreshed, &still_shared));
        drop(active);
        let retained = registry
            .for_scope(Uuid::new_v4(), "idle-eviction", None, None, deadline())
            .await
            .unwrap();
        assert_eq!(registry.entries.lock().await.len(), CAPACITY);
        assert_eq!(Arc::strong_count(&retained), 2);
        assert!(
            registry
                .for_scope(viewer, "login-one", None, None, Instant::now())
                .await
                .is_err()
        );
    }
}
