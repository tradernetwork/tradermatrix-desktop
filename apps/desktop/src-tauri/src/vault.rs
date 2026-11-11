//! Encrypted secret vault, the fallback `SecretStore` when no OS keyring is reachable.
//!
//! File layout (deviation from the plan sketch: a 32-byte key check is added so a wrong
//! passphrase and a tampered ciphertext are distinguishable, which an AEAD tag alone cannot do):
//! `RBV1 | salt(16) | nonce(24) | check(32) | ciphertext+tag`. The whole header is AAD.
//! Argon2id yields 64 bytes: the first 32 are the XChaCha20-Poly1305 key, the last 32 are `check`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use zeroize::{Zeroize, Zeroizing};

use crate::error::AppError;
use crate::secrets::{check_slot, check_value, BackendStatus, SecretStore};

const MAGIC: &[u8; 4] = b"RBV1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const CHECK_LEN: usize = 32;
const HEADER_LEN: usize = 4 + SALT_LEN + NONCE_LEN + CHECK_LEN;
const TAG_LEN: usize = 16;
const MIN_PASSPHRASE_CHARS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;

#[cfg(not(test))]
const KDF_M_KIB: u32 = 64 * 1024;
#[cfg(not(test))]
const KDF_T: u32 = 3;
#[cfg(test)]
const KDF_M_KIB: u32 = 64;
#[cfg(test)]
const KDF_T: u32 = 1;
const KDF_P: u32 = 1;

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; SALT_LEN],
    check: [u8; CHECK_LEN],
    map: BTreeMap<String, String>,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        for v in self.map.values_mut() {
            v.zeroize();
        }
        self.map.clear();
    }
}

pub struct Vault {
    path: PathBuf,
    state: Mutex<Option<Unlocked>>,
    /// Serializes `create` and `unlock` (single flight: a second concurrent call waits for the first).
    op: Mutex<()>,
}

fn rand_bytes<const N: usize>() -> Result<[u8; N], AppError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| AppError::Secret("system randomness unavailable".into()))?;
    Ok(b)
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<(Zeroizing<[u8; 32]>, [u8; CHECK_LEN]), AppError> {
    let params = Params::new(KDF_M_KIB, KDF_T, KDF_P, None).map_err(|_| AppError::Secret("bad kdf parameters".into()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; 64]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out[..])
        .map_err(|_| AppError::Secret("key derivation failed".into()))?;
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&out[..32]);
    let mut check = [0u8; CHECK_LEN];
    check.copy_from_slice(&out[32..]);
    Ok((key, check))
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header(salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN], check: &[u8; CHECK_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    h.extend_from_slice(check);
    h
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    PathBuf::from(s)
}

/// Writes `bytes` to a 0600 temp file next to `path`, fsyncs, then renames over `path`.
/// A crash at any point leaves either the old vault or the new one, never a partial file.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let tmp = tmp_path(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    let res = f.write_all(bytes).and_then(|_| f.sync_all());
    drop(f);
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Writes a NEW vault file: fully written and fsynced under a temp name, then hard-linked into place, which
/// fails if `path` already exists. Never overwrites, even if another process created it a moment ago.
fn create_new_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    // A name no other writer (thread or process) can share.
    let tag = u64::from_le_bytes(rand_bytes::<8>()?);
    let mut s = tmp_path(path).into_os_string();
    s.push(format!(".{}.{tag:016x}", std::process::id()));
    let tmp = PathBuf::from(s);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    let res = f.write_all(bytes).and_then(|_| f.sync_all());
    drop(f);
    let linked = res.and_then(|_| std::fs::hard_link(&tmp, path));
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AppError::Invalid("vault already exists; unlock it instead".into()))
        }
        Err(e) => return Err(e.into()),
    }
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Replaces the unlocked map and zeroizes the old values (a plain assignment would free them unscrubbed).
fn replace_map(u: &mut Unlocked, next: BTreeMap<String, String>) {
    let mut old = std::mem::replace(&mut u.map, next);
    for v in old.values_mut() {
        v.zeroize();
    }
}

fn seal(u: &Unlocked, map: &BTreeMap<String, String>) -> Result<Vec<u8>, AppError> {
    let plain = Zeroizing::new(serde_json::to_vec(map).map_err(|_| AppError::Secret("vault serialization failed".into()))?);
    let nonce = rand_bytes::<NONCE_LEN>()?;
    let hdr = header(&u.salt, &nonce, &u.check);
    let cipher = XChaCha20Poly1305::new_from_slice(&u.key[..]).map_err(|_| AppError::Secret("bad vault key".into()))?;
    let xn: XNonce = nonce.into();
    let ct = cipher
        .encrypt(&xn, Payload { msg: &plain, aad: &hdr })
        .map_err(|_| AppError::Secret("vault encryption failed".into()))?;
    let mut out = hdr;
    out.extend_from_slice(&ct);
    Ok(out)
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, state: Mutex::new(None), op: Mutex::new(()) }
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.state.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    fn guard(&self) -> Result<MutexGuard<'_, Option<Unlocked>>, AppError> {
        self.state.lock().map_err(|_| AppError::Secret("vault state poisoned".into()))
    }

    fn op_guard(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.op.lock().map_err(|_| AppError::Secret("vault state poisoned".into()))
    }

    pub fn create(&self, passphrase: &str) -> Result<(), AppError> {
        let _op = self.op_guard()?;
        if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
            return Err(AppError::Invalid(format!("passphrase must be at least {MIN_PASSPHRASE_CHARS} characters")));
        }
        if passphrase.len() > MAX_PASSPHRASE_BYTES {
            return Err(AppError::Invalid("passphrase too long".into()));
        }
        if self.exists() {
            return Err(AppError::Invalid("vault already exists; unlock it instead".into()));
        }
        let salt = rand_bytes::<SALT_LEN>()?;
        let (key, check) = derive(passphrase, &salt)?;
        let u = Unlocked { key, salt, check, map: BTreeMap::new() };
        let bytes = seal(&u, &u.map)?;
        create_new_write(&self.path, &bytes)?;
        *self.guard()? = Some(u);
        Ok(())
    }

    pub fn unlock(&self, passphrase: &str) -> Result<(), AppError> {
        let _op = self.op_guard()?;
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(AppError::Missing),
            Err(e) => return Err(e.into()),
        };
        if bytes.len() < HEADER_LEN + TAG_LEN {
            return Err(AppError::Corrupt("file too short".into()));
        }
        if &bytes[..4] != MAGIC {
            return Err(AppError::Corrupt("bad magic".into()));
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&bytes[4..4 + SALT_LEN]);
        let nonce_at = 4 + SALT_LEN;
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&bytes[nonce_at..nonce_at + NONCE_LEN]);
        let check_at = nonce_at + NONCE_LEN;
        let (key, check) = derive(passphrase, &salt)?;
        if !ct_eq(&check, &bytes[check_at..HEADER_LEN]) {
            return Err(AppError::WrongPassphrase);
        }
        let cipher = XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| AppError::Secret("bad vault key".into()))?;
        let xn: XNonce = nonce.into();
        let plain = cipher
            .decrypt(&xn, Payload { msg: &bytes[HEADER_LEN..], aad: &bytes[..HEADER_LEN] })
            .map_err(|_| AppError::Corrupt("authentication failed (file was modified or damaged)".into()))?;
        let plain = Zeroizing::new(plain);
        let map: BTreeMap<String, String> =
            serde_json::from_slice(&plain).map_err(|_| AppError::Corrupt("payload is not a slot map".into()))?;
        *self.guard()? = Some(Unlocked { key, salt, check, map });
        Ok(())
    }

    pub fn lock(&self) {
        if let Ok(mut g) = self.state.lock() {
            *g = None; // Drop zeroizes the key and the values.
        }
    }

    fn with_unlocked<T>(&self, f: impl FnOnce(&mut Unlocked) -> Result<T, AppError>) -> Result<T, AppError> {
        let mut g = self.guard()?;
        match g.as_mut() {
            Some(u) => f(u),
            None => Err(AppError::Secret("vault locked".into())),
        }
    }
}

impl SecretStore for Vault {
    fn set(&self, slot: &str, value: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        check_value(value)?;
        self.with_unlocked(|u| {
            let mut next = u.map.clone();
            next.insert(slot.to_string(), value.to_string());
            let res = seal(u, &next).and_then(|b| atomic_write(&self.path, &b));
            match res {
                Ok(()) => {
                    replace_map(u, next);
                    Ok(())
                }
                Err(e) => {
                    for v in next.values_mut() {
                        v.zeroize();
                    }
                    Err(e)
                }
            }
        })
    }

    fn exists(&self, slot: &str) -> Result<bool, AppError> {
        check_slot(slot)?;
        self.with_unlocked(|u| Ok(u.map.contains_key(slot)))
    }

    fn delete(&self, slot: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        self.with_unlocked(|u| {
            if !u.map.contains_key(slot) {
                return Ok(());
            }
            let mut next = u.map.clone();
            next.remove(slot);
            let res = seal(u, &next).and_then(|b| atomic_write(&self.path, &b));
            match res {
                Ok(()) => {
                    replace_map(u, next);
                    Ok(())
                }
                Err(e) => {
                    for v in next.values_mut() {
                        v.zeroize();
                    }
                    Err(e)
                }
            }
        })
    }

    fn get(&self, slot: &str) -> Result<Option<String>, AppError> {
        check_slot(slot)?;
        self.with_unlocked(|u| Ok(u.map.get(slot).cloned()))
    }

    fn status(&self) -> BackendStatus {
        let unlocked = self.is_unlocked();
        BackendStatus {
            available: unlocked,
            backend: "vault".into(),
            detail: if unlocked {
                "encrypted vault unlocked".into()
            } else if self.exists() {
                "vault locked".into()
            } else {
                "no vault yet; create one".into()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const PW: &str = "correct horse battery";

    fn tmp() -> (std::path::PathBuf, Vault) {
        let dir = std::env::temp_dir().join(format!(
            "rebull-vault-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("vault.rbv");
        (f.clone(), Vault::new(f))
    }

    #[test]
    fn create_unlock_round_trip() {
        let (path, v) = tmp();
        assert!(!v.exists());
        v.create(PW).unwrap();
        assert!(v.exists() && v.is_unlocked());
        SecretStore::set(&v, "tm_api_key", "fake-secret-value").unwrap();
        v.lock();
        assert!(!v.is_unlocked());
        let v2 = Vault::new(path);
        v2.unlock(PW).unwrap();
        assert_eq!(SecretStore::get(&v2, "tm_api_key").unwrap().as_deref(), Some("fake-secret-value"));
    }

    #[test]
    fn wrong_passphrase_is_distinct() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let v2 = Vault::new(path);
        assert!(matches!(v2.unlock("not the passphrase"), Err(AppError::WrongPassphrase)));
        assert!(!v2.is_unlocked());
    }

    #[test]
    fn flipped_ciphertext_byte_is_corrupt() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "x").unwrap();
        v.lock();
        let mut b = std::fs::read(&path).unwrap();
        let last = b.len() - 1;
        b[last] ^= 0x01;
        std::fs::write(&path, b).unwrap();
        assert!(matches!(Vault::new(path).unlock(PW), Err(AppError::Corrupt(_))));
    }

    #[test]
    fn flipped_header_byte_never_unlocks() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let mut b = std::fs::read(&path).unwrap();
        b[10] ^= 0x01; // salt byte
        std::fs::write(&path, b).unwrap();
        assert!(Vault::new(path).unlock(PW).is_err());
    }

    #[test]
    fn truncated_file_is_corrupt() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let b = std::fs::read(&path).unwrap();
        std::fs::write(&path, &b[..10]).unwrap();
        assert!(matches!(Vault::new(path).unlock(PW), Err(AppError::Corrupt(_))));
    }

    #[test]
    fn bad_magic_is_corrupt() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let mut b = std::fs::read(&path).unwrap();
        b[0] = b'X';
        std::fs::write(&path, b).unwrap();
        assert!(matches!(Vault::new(path).unlock(PW), Err(AppError::Corrupt(_))));
    }

    #[test]
    fn missing_file_is_missing() {
        let (_p, v) = tmp();
        assert!(matches!(v.unlock(PW), Err(AppError::Missing)));
    }

    #[test]
    fn create_twice_refuses_and_keeps_data() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "keep-me").unwrap();
        assert!(matches!(v.create("another passphrase"), Err(AppError::Invalid(_))));
        assert!(matches!(Vault::new(path.clone()).create(PW), Err(AppError::Invalid(_))));
        let v2 = Vault::new(path);
        v2.unlock(PW).unwrap();
        assert_eq!(SecretStore::get(&v2, "tm_api_key").unwrap().as_deref(), Some("keep-me"));
    }

    #[test]
    fn short_passphrase_rejected() {
        let (_p, v) = tmp();
        assert!(matches!(v.create("short"), Err(AppError::Invalid(_))));
        assert!(!v.exists());
    }

    #[test]
    fn set_before_unlock_fails_locked() {
        let (path, v) = tmp();
        let e = SecretStore::set(&v, "tm_api_key", "x").unwrap_err();
        assert!(e.to_string().contains("vault locked"));
        v.create(PW).unwrap();
        v.lock();
        for r in [
            SecretStore::set(&Vault::new(path.clone()), "tm_api_key", "x").map(|_| ()),
            SecretStore::get(&v, "tm_api_key").map(|_| ()),
            SecretStore::exists(&v, "tm_api_key").map(|_| ()),
            SecretStore::delete(&v, "tm_api_key"),
        ] {
            assert!(r.unwrap_err().to_string().contains("vault locked"));
        }
    }

    #[test]
    fn slot_allowlist_and_crud() {
        let (_p, v) = tmp();
        v.create(PW).unwrap();
        assert!(matches!(SecretStore::set(&v, "nope", "x"), Err(AppError::Invalid(_))));
        assert!(matches!(SecretStore::get(&v, "nope"), Err(AppError::Invalid(_))));
        assert!(matches!(SecretStore::exists(&v, "nope"), Err(AppError::Invalid(_))));
        assert!(matches!(SecretStore::delete(&v, "nope"), Err(AppError::Invalid(_))));
        assert!(matches!(SecretStore::set(&v, "tm_api_key", ""), Err(AppError::Invalid(_))));
        assert!(!SecretStore::exists(&v, "robinhood_oauth").unwrap());
        SecretStore::set(&v, "robinhood_oauth", "{\"a\":1}").unwrap();
        assert!(SecretStore::exists(&v, "robinhood_oauth").unwrap());
        SecretStore::delete(&v, "robinhood_oauth").unwrap();
        SecretStore::delete(&v, "robinhood_oauth").unwrap();
        assert_eq!(SecretStore::get(&v, "robinhood_oauth").unwrap(), None);
    }

    #[test]
    fn lock_clears_access() {
        let (_p, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "x").unwrap();
        v.lock();
        assert!(SecretStore::get(&v, "tm_api_key").is_err());
    }

    #[test]
    fn file_mode_is_0600() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "x").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn stray_tmp_file_does_not_break_unlock_or_writes() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let mut tmp_name = path.clone().into_os_string();
        tmp_name.push(".tmp");
        std::fs::write(&tmp_name, b"half written garbage").unwrap();
        let v2 = Vault::new(path);
        v2.unlock(PW).unwrap();
        SecretStore::set(&v2, "tm_api_key", "after-crash").unwrap();
        assert_eq!(SecretStore::get(&v2, "tm_api_key").unwrap().as_deref(), Some("after-crash"));
    }

    #[test]
    fn nonce_differs_across_writes_of_same_data() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "same").unwrap();
        let a = std::fs::read(&path).unwrap();
        SecretStore::set(&v, "tm_api_key", "same").unwrap();
        let b = std::fs::read(&path).unwrap();
        assert_eq!(a.len(), b.len());
        assert_ne!(a, b);
        assert_ne!(&a[20..44], &b[20..44], "nonce must be fresh");
        assert_ne!(&a[44..], &b[44..], "ciphertext must differ");
    }

    #[test]
    fn failed_write_does_not_change_memory_or_disk() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        SecretStore::set(&v, "tm_api_key", "good").unwrap();
        let before = std::fs::read(&path).unwrap();
        // Make the tmp path a directory so the atomic write cannot succeed.
        let mut tmp_name = path.clone().into_os_string();
        tmp_name.push(".tmp");
        std::fs::create_dir(&tmp_name).unwrap();
        assert!(SecretStore::set(&v, "tm_api_key", "bad").is_err());
        assert_eq!(SecretStore::get(&v, "tm_api_key").unwrap().as_deref(), Some("good"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    /// R5: two concurrent creates (double click, two windows) produce exactly one vault, never a silent overwrite.
    #[test]
    fn concurrent_create_is_single_flight_and_exclusive() {
        for _ in 0..5 {
            let (path, v) = tmp();
            let v = std::sync::Arc::new(v);
            let other = std::sync::Arc::new(Vault::new(path.clone()));
            let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
            let (a, g1) = (v.clone(), gate.clone());
            let (b, g2) = (other.clone(), gate.clone());
            let t1 = std::thread::spawn(move || { g1.wait(); a.create("passphrase-one") });
            let t2 = std::thread::spawn(move || { g2.wait(); b.create("passphrase-two") });
            let (r1, r2) = (t1.join().unwrap(), t2.join().unwrap());
            assert_eq!(r1.is_ok() as u8 + r2.is_ok() as u8, 1, "exactly one create wins: {r1:?} {r2:?}");
            let winner = if r1.is_ok() { "passphrase-one" } else { "passphrase-two" };
            Vault::new(path).unlock(winner).unwrap();
        }
    }

    #[test]
    fn errors_never_contain_passphrase() {
        let (path, v) = tmp();
        v.create(PW).unwrap();
        v.lock();
        let secret = "hunter2-hunter2";
        let e = Vault::new(path).unlock(secret).unwrap_err();
        assert!(!format!("{e} {e:?}").contains(secret));
        let e = v.create("tiny").unwrap_err();
        assert!(!format!("{e} {e:?}").contains("tiny"));
    }
}
