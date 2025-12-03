use chrono::Utc;
use rustc_version::version_meta;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let (repo_root, git_dir) = find_git_directories(&manifest_dir)
        .unwrap_or_else(|| panic!("Failed to find .git directory above {:?}", manifest_dir));

    let build_version = capture_git_hash(&repo_root);
    println!("cargo:rustc-env=BUILD_VERSION={build_version}");

    let build_date = format_build_date();
    println!("cargo:rustc-env=BUILD_DATE={build_date}");

    let rustc_version = capture_rustc_version();
    println!("cargo:rustc-env=RUSTC_VERSION={rustc_version}");

    println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
    if let Some(current_ref) = resolve_head_reference(&git_dir) {
        println!("cargo:rerun-if-changed={}", current_ref.display());
    }
    println!(
        "cargo:rerun-if-changed={}",
        git_dir.join("packed-refs").display()
    );
}

fn capture_git_hash(repo_root: &Path) -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(repo_root)
        .output()
        .unwrap_or_else(|err| panic!("Failed to execute git rev-parse: {err}"));

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!(
            "git rev-parse exited with {:?}: {}",
            output.status.code(),
            stderr.trim()
        );
    }

    let sha = String::from_utf8(output.stdout)
        .unwrap_or_else(|err| panic!("git rev-parse output was not UTF-8: {err}"));
    let trimmed = sha.trim();
    if trimmed.is_empty() {
        panic!("git rev-parse returned empty output");
    }
    trimmed.to_string()
}

fn format_build_date() -> String {
    Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string()
}

fn capture_rustc_version() -> String {
    match version_meta() {
        Ok(meta) => {
            if let (Some(hash), Some(date)) = (meta.commit_hash, meta.commit_date) {
                let short_hash: String = hash.chars().take(8).collect();
                format!("rustc {} ({} {})", meta.semver, short_hash, date)
            } else {
                format!("rustc {}", meta.semver)
            }
        }
        Err(_) => "unknown".to_string(),
    }
}

fn find_git_directories(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = Some(start);

    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.exists() {
            if candidate.is_dir() {
                return Some((dir.to_path_buf(), candidate));
            } else if let Some(resolved) = resolve_git_file(&candidate) {
                return Some((dir.to_path_buf(), resolved));
            }
        }

        current = dir.parent();
    }

    None
}

fn resolve_git_file(git_file: &Path) -> Option<PathBuf> {
    let contents = fs::read_to_string(git_file).ok()?;
    let path = contents.strip_prefix("gitdir:")?.trim();
    let base = git_file.parent()?;
    let git_dir = Path::new(path);

    if git_dir.is_absolute() {
        Some(git_dir.to_path_buf())
    } else {
        Some(base.join(git_dir))
    }
}

fn resolve_head_reference(git_dir: &Path) -> Option<PathBuf> {
    let head_path = git_dir.join("HEAD");
    let contents = fs::read_to_string(&head_path).ok()?;
    let head = contents.trim();
    let reference = head.strip_prefix("ref: ")?;
    Some(git_dir.join(reference))
}
