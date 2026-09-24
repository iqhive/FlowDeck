use crate::runner::{run, CommandOutput};
use anyhow::{bail, Result};

/// Run a linter with token-optimized output.
///
/// Supported linters: ruff, clippy, tsc, eslint, biome, golangci, rubocop.
pub fn run_linter(linter: &str, args: &[String]) -> Result<CommandOutput> {
    let output = match linter {
        "ruff" => run_ruff(args)?,
        "clippy" => run_clippy(args)?,
        "tsc" => run_tsc(args)?,
        "eslint" => run_eslint(args)?,
        "biome" => run_biome(args)?,
        "golangci" => run_golangci(args)?,
        "rubocop" => run_rubocop(args)?,
        _ => bail!(
            "unsupported linter: {} (supported: ruff, clippy, tsc, eslint, biome, golangci, rubocop)",
            linter
        ),
    };

    let compressed = compress_lint_output(linter, &output)?;
    Ok(compressed)
}

fn run_ruff(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["check", "--output-format", "json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("ruff", &cmd_args)
}

fn run_clippy(args: &[String]) -> Result<CommandOutput> {
    // Partition args: rustc lint flags (-D/-A/-W/-F) must go after `--`;
    // everything else (clippy flags, paths) goes before.
    let (rustc_flags, clippy_flags): (Vec<&str>, Vec<&str>) =
        args.iter().map(|s| s.as_str()).partition(|s| {
            s.starts_with('-') && s.chars().nth(1).is_some_and(|c| "DAWFLR".contains(c))
        });

    let mut cmd_args = vec!["clippy"];
    cmd_args.extend(clippy_flags);
    cmd_args.push("--message-format");
    cmd_args.push("json");
    if !rustc_flags.is_empty() {
        cmd_args.push("--");
        cmd_args.extend(rustc_flags);
    }
    run("cargo", &cmd_args)
}

fn run_tsc(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["--noEmit"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("tsc", &cmd_args)
}

fn run_eslint(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["--format", "json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("eslint", &cmd_args)
}

fn run_biome(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["check", "--reporter=json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("biome", &cmd_args)
}

fn run_golangci(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["run", "--out-format", "json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);

    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    // Single-module repo: keep today's behavior (run in the inherited cwd).
    if cwd.join("go.mod").is_file() {
        return run("golangci-lint", &cmd_args);
    }
    // Multi-module workspace: one `golangci-lint run` per `use` dir, then
    // merge the JSON `Issues` arrays so the existing compressor just works.
    let go_work = cwd.join("go.work");
    if go_work.is_file() {
        if let Ok(content) = std::fs::read_to_string(&go_work) {
            let modules = crate::reader::test_runner::parse_go_work_uses(&content);
            if !modules.is_empty() {
                return run_golangci_workspace(&cwd, &modules, &cmd_args);
            }
        }
        // Unparseable/empty go.work: fall through to the natural error.
    }
    run("golangci-lint", &cmd_args)
}

/// A `use` dir from go.work is safe only if it is relative and stays
/// inside the workspace root. Reject absolute paths and any `..` segment.
fn is_safe_workspace_module(module: &str) -> bool {
    if module.is_empty() {
        return false;
    }
    let path = std::path::Path::new(module);
    if path.is_absolute() {
        return false;
    }
    !path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    })
}

/// Pure merge step for per-module golangci JSON outputs.
///
/// Each entry is `(module, stdout, exit_code, success)`. Merges the `Issues`
/// arrays with module-dir-prefixed filenames, rolls up the exit code
/// (any non-zero wins, first one kept), and concatenates per-module stderr
/// plus skip notes. Non-JSON/empty bodies contribute zero issues but keep
/// their diagnostics via `stderrs`.
fn merge_golangci_module_outputs(
    results: &[(&str, &str, i32, bool)],
    stderrs: &[(&str, &str)],
) -> (Vec<serde_json::Value>, String, i32, bool) {
    let mut issues: Vec<serde_json::Value> = Vec::new();
    let mut notes = String::new();
    let mut success = true;
    let mut first_code = 0;
    for (module, stdout, exit_code, ok) in results {
        if !ok {
            // golangci-lint exits 1 when findings exist — normal.
            success = false;
            if first_code == 0 {
                first_code = *exit_code;
            }
        }
        if let Ok(data) = serde_json::from_str::<serde_json::Value>(stdout) {
            if let Some(arr) = data.get("Issues").and_then(|v| v.as_array()) {
                for mut issue in arr.iter().cloned() {
                    let rel = issue
                        .pointer("/Pos/Filename")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let prefixed = if rel.is_empty()
                        || std::path::Path::new(&rel).is_absolute()
                    {
                        rel
                    } else {
                        format!("{}/{}", module.trim_end_matches('/'), rel)
                    };
                    if let Some(pos) = issue.get_mut("Pos") {
                        pos["Filename"] = serde_json::Value::String(prefixed);
                    }
                    issues.push(issue);
                }
            }
        }
    }
    for (module, stderr) in stderrs {
        if !stderr.is_empty() {
            notes.push_str(&format!("=== {} (stderr) ===\n{}", module, stderr));
            if !stderr.ends_with('\n') {
                notes.push('\n');
            }
        }
    }
    (
        issues,
        notes,
        if success { 0 } else { first_code },
        success,
    )
}

/// Run `golangci-lint` once per go.work module dir and merge the JSON
/// outputs into a single `{ "Issues": [...] }` document. Prefixes each
/// issue filename with its module dir so findings stay attributable.
/// Unsafe `use` dirs (absolute or containing `..`) are skipped with a
/// stderr note instead of executed.
fn run_golangci_workspace(
    root: &std::path::Path,
    modules: &[String],
    cmd_args: &[&str],
) -> Result<CommandOutput> {
    use crate::runner::run_in_dir;
    let mut results: Vec<(String, String, i32, bool)> = Vec::new();
    let mut stderrs: Vec<(String, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for module in modules {
        if !is_safe_workspace_module(module) {
            skipped.push(module.clone());
            continue;
        }
        let dir = root.join(module);
        match run_in_dir("golangci-lint", cmd_args, &[], Some(&dir)) {
            Ok(out) => {
                stderrs.push((module.clone(), out.stderr.clone()));
                results.push((
                    module.clone(),
                    out.stdout.clone(),
                    out.exit_code,
                    out.success,
                ));
            }
            Err(e) => bail!("error running golangci-lint in {}: {}", module, e),
        }
    }
    let borrowed: Vec<(&str, &str, i32, bool)> = results
        .iter()
        .map(|(m, s, c, ok)| (m.as_str(), s.as_str(), *c, *ok))
        .collect();
    let borrowed_err: Vec<(&str, &str)> = stderrs
        .iter()
        .map(|(m, e)| (m.as_str(), e.as_str()))
        .collect();
    let (issues, mut notes, exit_code, success) =
        merge_golangci_module_outputs(&borrowed, &borrowed_err);
    for module in skipped {
        notes.push_str(&format!(
            "=== {} (skipped) ===\nunsafe go.work use dir: absolute or contains '..'\n",
            module
        ));
    }
    Ok(CommandOutput {
        stdout: serde_json::json!({ "Issues": issues }).to_string(),
        stderr: notes,
        exit_code,
        success,
    })
}

fn run_rubocop(args: &[String]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["--format", "json"];
    let extra: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    cmd_args.extend(extra);
    run("rubocop", &cmd_args)
}

/// Compress lint output to show findings grouped by file.
fn compress_lint_output(linter: &str, output: &CommandOutput) -> Result<CommandOutput> {
    match linter {
        "ruff" => compress_ruff_output(output),
        "clippy" => compress_clippy_output(output),
        "tsc" => compress_tsc_output(output),
        "eslint" => compress_eslint_output(output),
        "biome" => compress_biome_output(output),
        "golangci" => compress_golangci_output(output),
        "rubocop" => compress_rubocop_output(output),
        _ => Ok(output.clone()),
    }
}

fn compress_ruff_output(output: &CommandOutput) -> Result<CommandOutput> {
    if output.stdout.trim().is_empty() || output.stdout == "[]" {
        return Ok(CommandOutput {
            stdout: "ok  no issues\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    let findings: Vec<serde_json::Value> =
        serde_json::from_str(&output.stdout).unwrap_or_default();

    let mut result = format_findings("ruff", &findings, |f| {
        let file = f.get("filename").and_then(|v| v.as_str()).unwrap_or("unknown");
        let line = f.get("location").and_then(|l| l.get("row")).and_then(|v| v.as_u64()).unwrap_or(0);
        let code = f.get("code").and_then(|v| v.as_str()).unwrap_or("unknown");
        let msg = f.get("message").and_then(|v| v.as_str()).unwrap_or("");
        (file.to_string(), line as usize, code.to_string(), msg.to_string())
    });

    if result.is_empty() {
        result = "ok  no issues\n".to_string();
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn compress_clippy_output(output: &CommandOutput) -> Result<CommandOutput> {
    // cargo clippy --message-format json emits compiler messages to stderr
    let source = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
    let mut findings = Vec::new();
    let mut compile_errors = Vec::new();

    for line in source.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // surface non-JSON compile errors so the agent sees the real problem
                if line.contains("error") || line.contains("warning") {
                    compile_errors.push(line.trim().to_string());
                }
                continue;
            }
        };

        if msg.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }

        let level = msg
            .get("message")
            .and_then(|m| m.get("level"))
            .and_then(|l| l.as_str())
            .unwrap_or("");
        if level != "warning" && level != "error" {
            continue;
        }

        let file = msg
            .get("message")
            .and_then(|m| m.get("spans"))
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|span| span.get("file_name"))
            .and_then(|f| f.as_str())
            .unwrap_or("unknown");
        let line_num = msg
            .get("message")
            .and_then(|m| m.get("spans"))
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|span| span.get("line_start"))
            .and_then(|l| l.as_u64())
            .unwrap_or(0);
        let code = msg
            .get("message")
            .and_then(|m| m.get("code"))
            .and_then(|c| c.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("clippy");
        let message = msg
            .get("message")
            .and_then(|m| m.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        findings.push((
            file.to_string(),
            line_num as usize,
            code.to_string(),
            message.to_string(),
        ));
    }

    let mut result = format_findings_vec("clippy", &findings);
    if result.is_empty() {
        if compile_errors.is_empty() {
            result = "ok  no issues\n".to_string();
        } else {
            let errs = compile_errors.iter().map(|e| format!("  {e}")).collect::<Vec<_>>().join("\n");
            result = format!("{} compile errors:\n{}\n", compile_errors.len(), errs);
        }
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn compress_tsc_output(output: &CommandOutput) -> Result<CommandOutput> {
    let mut findings = Vec::new();

    for line in output.stdout.lines() {
        // Pattern: file.ts(12,5): error TS2345: <message>
        if let Some(colon_idx) = line.find(": error TS") {
            let prefix = &line[..colon_idx];
            let rest = &line[colon_idx + 2..]; // skip ": "

            if let Some(paren_idx) = prefix.rfind('(') {
                let file = &prefix[..paren_idx];
                let loc = &prefix[paren_idx + 1..prefix.len() - 1]; // strip ()
                let line_num: usize = loc.split(',').next().unwrap_or("0").parse().unwrap_or(0);

                let code_end = rest.find(':').unwrap_or(rest.len());
                let code = &rest[..code_end];
                let msg = &rest[code_end.min(rest.len())..].trim_start_matches(": ");

                findings.push((file.to_string(), line_num, code.to_string(), msg.to_string()));
            }
        }
    }

    let mut result = format_findings_vec("tsc", &findings);
    if result.is_empty() {
        result = "ok  no issues\n".to_string();
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn compress_eslint_output(output: &CommandOutput) -> Result<CommandOutput> {
    if output.stdout.trim().is_empty() || output.stdout == "[]" {
        return Ok(CommandOutput {
            stdout: "ok  no issues\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
            success: true,
        });
    }

    let files: Vec<serde_json::Value> =
        serde_json::from_str(&output.stdout).unwrap_or_default();

    let mut all_findings = Vec::new();
    for file in files {
        let path = file.get("filePath").and_then(|v| v.as_str()).unwrap_or("unknown");
        if let Some(messages) = file.get("messages").and_then(|v| v.as_array()) {
            for msg in messages {
                let line = msg.get("line").and_then(|v| v.as_u64()).unwrap_or(0);
                let code = msg.get("ruleId").and_then(|v| v.as_str()).unwrap_or("unknown");
                let message = msg.get("message").and_then(|v| v.as_str()).unwrap_or("");
                all_findings.push((
                    path.to_string(),
                    line as usize,
                    code.to_string(),
                    message.to_string(),
                ));
            }
        }
    }

    let mut result = format_findings_vec("eslint", &all_findings);
    if result.is_empty() {
        result = "ok  no issues\n".to_string();
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn compress_biome_output(output: &CommandOutput) -> Result<CommandOutput> {
    // Biome JSON format is similar to eslint
    compress_eslint_output(output)
}

fn compress_golangci_output(output: &CommandOutput) -> Result<CommandOutput> {
    let data: serde_json::Value = serde_json::from_str(&output.stdout).unwrap_or_default();
    let mut all_findings = Vec::new();

    if let Some(issues) = data.get("Issues").and_then(|v| v.as_array()) {
        for issue in issues {
            let file = issue
                .get("Pos")
                .and_then(|p| p.get("Filename"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let line = issue
                .get("Pos")
                .and_then(|p| p.get("Line"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let code = issue
                .get("FromLinter")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let msg = issue
                .get("Text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            all_findings.push((
                file.to_string(),
                line as usize,
                code.to_string(),
                msg.to_string(),
            ));
        }
    }

    let mut result = format_findings_vec("golangci", &all_findings);
    if result.is_empty() {
        result = "ok  no issues\n".to_string();
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn compress_rubocop_output(output: &CommandOutput) -> Result<CommandOutput> {
    let data: serde_json::Value = serde_json::from_str(&output.stdout).unwrap_or_default();
    let mut all_findings = Vec::new();

    if let Some(files) = data.get("files").and_then(|v| v.as_array()) {
        for file in files {
            let path = file.get("path").and_then(|v| v.as_str()).unwrap_or("unknown");
            if let Some(offenses) = file.get("offenses").and_then(|v| v.as_array()) {
                for offense in offenses {
                    let line = offense
                        .get("location")
                        .and_then(|l| l.get("line"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let code = offense
                        .get("cop_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let msg = offense
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    all_findings.push((
                        path.to_string(),
                        line as usize,
                        code.to_string(),
                        msg.to_string(),
                    ));
                }
            }
        }
    }

    let mut result = format_findings_vec("rubocop", &all_findings);
    if result.is_empty() {
        result = "ok  no issues\n".to_string();
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: String::new(),
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn format_findings<F>(
    _linter: &str,
    findings: &[serde_json::Value],
    extractor: F,
) -> String
where
    F: Fn(&serde_json::Value) -> (String, usize, String, String),
{
    let mut extracted: Vec<(String, usize, String, String)> =
        findings.iter().map(extractor).collect();
    extracted.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    format_findings_vec(_linter, &extracted)
}

fn format_findings_vec(
    _linter: &str,
    findings: &[(String, usize, String, String)],
) -> String {
    if findings.is_empty() {
        return String::new();
    }

    let mut result = String::new();
    let mut current_file = String::new();
    let mut file_count = 0;
    let mut total_count = 0;

    const MAX_FINDINGS: usize = 80;
    let truncated = findings.len() > MAX_FINDINGS;
    let display = if truncated {
        &findings[..MAX_FINDINGS]
    } else {
        findings
    };

    for (file, line, code, msg) in display {
        if file != &current_file {
            if !current_file.is_empty() {
                result.push('\n');
            }
            current_file = file.clone();
            file_count += 1;
        }
        result.push_str(&format!("  {}:{}  {}  {}\n", file, line, code, msg));
        total_count += 1;
    }

    result.push_str(&format!("\n{} issues across {} files\n", total_count, file_count));

    if truncated {
        result.push_str(&format!(
            "[{} more findings not shown]\n",
            findings.len() - MAX_FINDINGS
        ));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_json(filename: &str, text: &str) -> String {
        serde_json::json!({
            "Issues": [
                {"Pos": {"Filename": filename, "Line": 1},
                 "FromLinter": "govet", "Text": text}
            ]
        })
        .to_string()
    }

    #[test]
    fn merges_issues_across_modules() {
        let a = issue_json("foo.go", "a");
        let b = issue_json("bar.go", "b");
        let results = vec![
            ("./mod-a", a.as_str(), 1, false),
            ("./mod-b", b.as_str(), 1, false),
        ];
        let (issues, notes, code, success) =
            merge_golangci_module_outputs(&results, &[]);
        assert_eq!(issues.len(), 2);
        assert!(notes.is_empty());
        assert_eq!(code, 1);
        assert!(!success);
    }

    #[test]
    fn prefixes_filenames_with_module_dir() {
        let a = issue_json("sub/foo.go", "x");
        let results = vec![("./services/api-gateway", a.as_str(), 1, false)];
        let (issues, _, _, _) = merge_golangci_module_outputs(&results, &[]);
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].pointer("/Pos/Filename").and_then(|v| v.as_str()),
            Some("./services/api-gateway/sub/foo.go")
        );
    }

    #[test]
    fn rolls_up_exit_code_on_any_failure() {
        let ok = serde_json::json!({"Issues": []}).to_string();
        let bad = issue_json("foo.go", "x");
        let results = vec![
            ("./a", ok.as_str(), 0, true),
            ("./b", bad.as_str(), 1, false),
            ("./c", ok.as_str(), 0, true),
        ];
        let (_, _, code, success) = merge_golangci_module_outputs(&results, &[]);
        assert_eq!(code, 1);
        assert!(!success);
        let results = vec![
            ("./a", ok.as_str(), 0, true),
            ("./b", ok.as_str(), 0, true),
        ];
        let (_, _, code, success) = merge_golangci_module_outputs(&results, &[]);
        assert_eq!(code, 0);
        assert!(success);
    }

    #[test]
    fn empty_issue_sets_merge_clean() {
        let ok = serde_json::json!({"Issues": []}).to_string();
        let results = vec![
            ("./a", ok.as_str(), 0, true),
            ("./b", ok.as_str(), 0, true),
        ];
        let (issues, _, code, success) =
            merge_golangci_module_outputs(&results, &[]);
        assert!(issues.is_empty());
        assert_eq!(code, 0);
        assert!(success);
    }

    #[test]
    fn non_json_body_keeps_stderr_diagnostics() {
        let results = vec![("./broken", "", 2, false)];
        let stderrs = vec![("./broken", "fatal: cannot load config")];
        let (issues, notes, code, success) =
            merge_golangci_module_outputs(&results, &stderrs);
        assert!(issues.is_empty());
        assert!(notes.contains("./broken"));
        assert!(notes.contains("fatal: cannot load config"));
        assert_eq!(code, 2);
        assert!(!success);
    }

    #[test]
    fn rejects_unsafe_module_dirs() {
        assert!(is_safe_workspace_module("./services/a"));
        assert!(is_safe_workspace_module("pkg"));
        assert!(!is_safe_workspace_module("/etc"));
        assert!(!is_safe_workspace_module("../evil"));
        assert!(!is_safe_workspace_module("./a/../b"));
        assert!(!is_safe_workspace_module(""));
    }
}
