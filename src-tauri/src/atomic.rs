use crate::error::{AppError, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 原子写：临时文件 -> fsync -> rename。
/// 断电/崩溃时用户要么拿到旧文件，要么拿到新文件，绝不会拿到半个文件。
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io(format!("路径没有父目录：{}", path.display())))?;
    fs::create_dir_all(dir)?;

    // 临时文件必须和目标同目录，否则 rename 可能跨卷失败
    let tmp = dir.join(format!(
        ".{}.dbkey.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("config")
    ));

    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }

    // Windows 上 rename 到已存在的文件会失败，必须先删
    #[cfg(windows)]
    {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Io(format!("写入 {} 失败：{}", path.display(), e))
    })?;

    restrict_permissions(path);
    Ok(())
}

/// 配置里有明文 API Key，权限必须收紧到只有当前用户可读。
/// 失败不致命 —— 配置已经写成功了，不能因为改权限失败就整体回滚。
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // icacls: 关闭继承并只保留当前用户
        if let Some(p) = path.to_str() {
            let user = std::env::var("USERNAME").unwrap_or_default();
            if !user.is_empty() {
                let _ = std::process::Command::new("icacls")
                    .args([p, "/inheritance:r", "/grant:r", &format!("{}:F", user)])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW，别闪黑框
                    .output();
            }
        }
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 多文件事务式写入。
/// 任何一步失败，已写的文件全部还原 ——
/// 避免用户落到"Codex 配好了但 Claude Code 写了一半"这种半残状态。
pub struct TwoFileTxn {
    rollback: Vec<(PathBuf, Option<String>)>,
}

impl TwoFileTxn {
    pub fn new() -> Self {
        Self {
            rollback: Vec::new(),
        }
    }

    /// 写一个文件，同时记下它的原始内容以备回滚
    pub fn write(&mut self, path: &Path, content: &str) -> Result<()> {
        let original = match fs::read_to_string(path) {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(AppError::Io(e.to_string())),
        };

        match write_atomic(path, content) {
            Ok(()) => {
                self.rollback.push((path.to_path_buf(), original));
                Ok(())
            }
            Err(e) => {
                self.rollback_all();
                Err(e)
            }
        }
    }

    /// 把这个事务里已经写过的文件全部还原
    pub fn rollback_all(&mut self) {
        for (path, original) in self.rollback.drain(..).rev() {
            match original {
                Some(content) => {
                    let _ = write_atomic(&path, &content);
                }
                // 原本不存在的文件，回滚就是删掉
                None => {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    pub fn commit(mut self) {
        self.rollback.clear();
    }
}
