//! Finding the potrace and autotrace binaries and their versions.
//!
//! Order: the path chosen in the app, the TAURINEATE_<ENGINE> environment variable,
//! PATH, a list of usual install folders, and finally the login shell's PATH
//! (apps started from Finder or a desktop launcher don't get the shell PATH).
//! A candidate only counts if `--version` runs and names the right program.

use crate::tracers::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Custom,
    Env,
    Path,
    Standard,
    LoginShell,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerInfo {
    pub engine: Engine,
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<Source>,
    /// The environment variable that can point at this tracer.
    pub env_var: String,
    /// The path chosen in the app, if any (even when it no longer works).
    pub custom_path: Option<String>,
    /// Problems with the chosen path or the environment variable, which were skipped.
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

pub fn env_var(engine: Engine) -> String {
    format!("TAURINEATE_{}", engine.binary().to_ascii_uppercase())
}

/// Usual install folders, beyond PATH. `~` is the home directory.
const STANDARD_DIRS: &[&str] = &[
    "/opt/homebrew/bin",                 // Homebrew, Apple silicon
    "/usr/local/bin",                    // Homebrew on Intel, source installs
    "/opt/local/bin",                    // MacPorts
    "/usr/bin",                          // Linux packages
    "/home/linuxbrew/.linuxbrew/bin",    // Homebrew on Linux
    "~/.linuxbrew/bin",
    "~/.nix-profile/bin",                // Nix
    "/nix/var/nix/profiles/default/bin",
    "/run/current-system/sw/bin",        // NixOS
    "/snap/bin",
    "~/.local/bin",
    "~/bin",
];

pub fn resolve(engine: Engine, custom: Option<&Path>) -> TracerInfo {
    let mut info = TracerInfo {
        engine,
        path: None,
        version: None,
        source: None,
        env_var: env_var(engine),
        custom_path: custom.map(|p| p.display().to_string()),
        warnings: Vec::new(),
        error: None,
    };

    if let Some(p) = custom {
        match check(engine, p) {
            Ok(version) => return info.found(p, version, Source::Custom),
            Err(e) => info.warnings.push(format!("Your chosen path is skipped: {e}")),
        }
    }
    if let Some(p) = std::env::var_os(&info.env_var).filter(|v| !v.is_empty()).map(PathBuf::from) {
        match check(engine, &p) {
            Ok(version) => return info.found(&p, version, Source::Env),
            Err(e) => info.warnings.push(format!("${} is skipped: {e}", info.env_var)),
        }
    }
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let candidates = [
        (Source::Path, path_dirs),
        (Source::Standard, STANDARD_DIRS.iter().map(|d| expand_home(d)).collect()),
    ];
    for (source, dirs) in candidates {
        if let Some((p, version)) = first_working(engine, &dirs) {
            return info.found(&p, version, source);
        }
    }
    // Last resort, so a normal start never waits on the shell.
    if let Some((p, version)) = first_working(engine, login_shell_path()) {
        return info.found(&p, version, Source::LoginShell);
    }
    info.error = Some(format!("{} not found", engine.binary()));
    info
}

impl TracerInfo {
    fn found(mut self, path: &Path, version: String, source: Source) -> Self {
        self.path = Some(path.display().to_string());
        self.version = Some(version);
        self.source = Some(source);
        self
    }
}

/// PATH plus the usual folders, without running anything (used by tests to find helper programs).
#[cfg(test)]
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path_dirs.into_iter().chain(STANDARD_DIRS.iter().map(|d| expand_home(d))).map(|d| d.join(name)).find(|p| p.is_file())
}

fn first_working(engine: Engine, dirs: &[PathBuf]) -> Option<(PathBuf, String)> {
    dirs.iter()
        .map(|d| d.join(engine.binary()))
        .filter(|p| p.is_file())
        .find_map(|p| check(engine, &p).ok().map(|v| (p, v)))
}

/// Runs `--version` and checks the output names the expected program; returns the version.
pub fn check(engine: Engine, path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("{} does not exist", path.display()));
    }
    let out = run_with_timeout(Command::new(path).arg("--version"), Duration::from_secs(5))
        .map_err(|e| format!("{} does not run: {e}", path.display()))?;
    if !out.to_ascii_lowercase().contains(engine.binary()) {
        return Err(format!("{} is not {}", path.display(), engine.binary()));
    }
    parse_version(&out).ok_or_else(|| format!("{} printed no version", path.display()))
}

/// The PATH a login shell sets up (reads the user's profile once; never asks to change it).
fn login_shell_path() -> &'static [PathBuf] {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        let Some(shell) = std::env::var_os("SHELL") else { return Vec::new() };
        let mut cmd = Command::new(shell);
        cmd.args(["-ilc", "printf '\\n__TAURINEATE__%s__TAURINEATE__\\n' \"$PATH\""]);
        let Ok(out) = run_with_timeout(&mut cmd, Duration::from_secs(3)) else { return Vec::new() };
        out.split("__TAURINEATE__").nth(1).map(|p| std::env::split_paths(p).collect()).unwrap_or_default()
    })
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn expand_home(dir: &str) -> PathBuf {
    match (dir.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(dir),
    }
}

/// Extracts the first dotted version number, e.g. "potrace 1.16. Copyright…" -> "1.16".
pub fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.chars().any(|c| c.is_ascii_digit()))?;
    let start = line.find(|c: char| c.is_ascii_digit())?;
    let version: String = line[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    Some(version.trim_end_matches('.').to_string()).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_version_lines() {
        assert_eq!(parse_version("potrace 1.16. Copyright (C) 2001-2019 Peter Selinger.").as_deref(), Some("1.16"));
        assert_eq!(parse_version("AutoTrace version 0.40.0.\n").as_deref(), Some("0.40.0"));
        assert_eq!(parse_version("no digits here"), None);
    }

    #[test]
    fn rejects_missing_and_wrong_programs() {
        assert!(check(Engine::Potrace, Path::new("/nonexistent/potrace")).unwrap_err().contains("does not exist"));
        // `echo --version` prints "--version": runs fine, but it isn't potrace.
        assert!(check(Engine::Potrace, Path::new("/bin/echo")).unwrap_err().contains("is not potrace"));
    }

    #[test]
    fn broken_custom_path_falls_back_with_a_warning() {
        let info = resolve(Engine::Potrace, Some(Path::new("/nonexistent/potrace")));
        assert_eq!(info.custom_path.as_deref(), Some("/nonexistent/potrace"));
        assert!(info.warnings[0].contains("chosen path is skipped"));
        assert_ne!(info.source, Some(Source::Custom));
    }

    #[test]
    fn home_is_expanded() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~/bin"), PathBuf::from(home).join("bin"));
        assert_eq!(expand_home("/usr/bin"), PathBuf::from("/usr/bin"));
    }
}
