use std::path::PathBuf;
use std::process::Command;

fn fdx_bin() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../target/release/fdx");
    path
}

#[test]
fn test_git_status() {
    let output = Command::new(fdx_bin())
        .args(["git", "status"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git status failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Should show either clean or some status groups
    assert!(
        stdout.contains("clean") || stdout.contains("staged") || stdout.contains("unstaged"),
        "should show status: {}",
        stdout
    );
    assert!(output.status.success());
}

#[test]
fn test_git_log() {
    let output = Command::new(fdx_bin())
        .args(["git", "log", "-n", "3"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git log failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Should show commit SHAs (7 hex chars)
    assert!(stdout.len() > 20, "should have log output: {}", stdout);
    assert!(output.status.success());
}

fn setup_branch_fixture(temp_dir: &str, branch: &str) {
    // Hermetic fixture: own throwaway repo with a known checked-out branch,
    // so the assertion never depends on the outer checkout's branch name.
    let _ = std::fs::remove_dir_all(temp_dir);
    std::fs::create_dir_all(temp_dir).unwrap();

    let run = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(temp_dir)
            .output()
            .expect("git fixture command failed");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["init"]);
    run(&["config", "user.email", "test@test.com"]);
    run(&["config", "user.name", "Test"]);
    run(&["checkout", "-b", branch]);
    std::fs::write(format!("{}/test.txt", temp_dir), "fixture\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "fixture"]);
}

#[test]
fn test_git_branch() {
    let branch = "fixture-branch-name";
    let temp_dir = "/tmp/fdx_git_branch_test";
    setup_branch_fixture(temp_dir, branch);

    let output = Command::new(fdx_bin())
        .args(["git", "branch"])
        .current_dir(temp_dir)
        .output()
        .expect("fdx git branch failed");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(&format!("* {} →", branch)),
        "should show current branch as current: {}",
        stdout
    );
    assert!(output.status.success());

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[test]
fn test_git_pass_through() {
    // Test that unknown subcommands pass through
    let output = Command::new(fdx_bin())
        .args(["git", "config", "--list"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fdx git config failed");

    assert!(output.status.success(), "git config should succeed");
}
