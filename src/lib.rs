//! Live Server++ for Zed.
//!
//! Zed extensions can't open sockets or subscribe to buffer changes themselves, so the
//! heavy lifting is done by a small Node.js program (`server/live-server.js`) that Zed runs
//! as a *language server* for HTML, CSS and JavaScript. Being a language server gives it
//! the live (unsaved) contents of every buffer, and its code actions act as the
//! "Go Live" / "Stop" controls.
//!
//! This crate embeds that program, writes it into the extension's working directory and
//! tells Zed how to launch it with Zed's bundled Node.js runtime.

use std::fs;
use std::path::{Path, PathBuf};

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const SERVER_DIR: &str = "live-server-plus-plus";
const SERVER_SCRIPT: &str = "live-server.js";
const CLIENT_SCRIPT: &str = "client.js";

const SERVER_SOURCE: &str = include_str!("../server/live-server.js");
const CLIENT_SOURCE: &str = include_str!("../server/client.js");

struct LiveServerPlusPlus {
    installed: bool,
}

impl LiveServerPlusPlus {
    /// Writes the bundled server files into the extension's working directory (only when
    /// they changed, e.g. after the extension was updated) and returns the script's path.
    fn install_server(&mut self) -> Result<PathBuf> {
        let work_dir = std::env::current_dir().map_err(|e| format!("no working directory: {e}"))?;
        let dir = work_dir.join(SERVER_DIR);
        let script = dir.join(SERVER_SCRIPT);

        if !self.installed {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
            write_if_changed(&script, SERVER_SOURCE)?;
            write_if_changed(&dir.join(CLIENT_SCRIPT), CLIENT_SOURCE)?;
            self.installed = true;
        }

        Ok(script)
    }

    fn settings(
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Option<LspSettings> {
        LspSettings::for_worktree(language_server_id.as_ref(), worktree).ok()
    }
}

fn write_if_changed(path: &Path, contents: &str) -> Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    fs::write(path, contents).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

impl zed::Extension for LiveServerPlusPlus {
    fn new() -> Self {
        Self { installed: false }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let script = self.install_server()?;
        let binary = Self::settings(language_server_id, worktree).and_then(|s| s.binary);

        // `lsp.live-server-plus-plus.binary.path` may point at a custom Node.js executable.
        let node = match binary.as_ref().and_then(|b| b.path.clone()) {
            Some(path) => path,
            None => zed::node_binary_path()?,
        };

        let mut args = vec![script.to_string_lossy().into_owned()];
        if let Some(extra) = binary.as_ref().and_then(|b| b.arguments.clone()) {
            args.extend(extra);
        }

        let mut env = worktree.shell_env();
        if let Some(extra) = binary.and_then(|b| b.env) {
            env.extend(extra);
        }

        Ok(zed::Command {
            command: node,
            args,
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        // Both `initialization_options` and `settings` are accepted; `settings` wins.
        let settings = Self::settings(language_server_id, worktree);
        let merged = settings.map(|s| merge(s.initialization_options, s.settings));
        Ok(merged)
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings = Self::settings(language_server_id, worktree);
        Ok(settings.map(|s| merge(s.initialization_options, s.settings)))
    }
}

/// Shallow-merges two optional JSON objects, the second one taking precedence.
fn merge(
    base: Option<zed::serde_json::Value>,
    overrides: Option<zed::serde_json::Value>,
) -> zed::serde_json::Value {
    use zed::serde_json::{Map, Value};
    let mut result = Map::new();
    for value in [base, overrides].into_iter().flatten() {
        if let Value::Object(map) = value {
            result.extend(map);
        }
    }
    Value::Object(result)
}

zed::register_extension!(LiveServerPlusPlus);
