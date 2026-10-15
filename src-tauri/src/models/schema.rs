use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u32,
    pub entries: Vec<CatalogEntry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub variant: String,
    pub revision: String,
    pub enabled: bool,
    pub experimental: bool,
    pub files: Vec<Artifact>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub chunks: Vec<Chunk>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
    pub sources: Vec<Source>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub id: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub source: Option<String>,
    pub error: Option<String>,
    pub path: Option<String>,
}
impl DownloadStatus {
    pub fn new(e: &CatalogEntry) -> Self {
        Self {
            id: e.id.clone(),
            phase: "not_installed".into(),
            downloaded_bytes: 0,
            total_bytes: e.files.iter().map(|a| a.size).sum(),
            source: None,
            error: None,
            path: None,
        }
    }
}
pub fn basename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 180
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_ .".contains(&b))
        && Path::new(name).components().count() == 1
        && matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
impl Catalog {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("模型清单版本不兼容".into());
        }
        let mut ids = std::collections::HashSet::new();
        for e in &self.entries {
            if !basename(&e.id)
                || !basename(&e.revision)
                || !ids.insert(&e.id)
                || !matches!(e.kind.as_str(), "model" | "backend")
                || e.files.is_empty()
            {
                return Err("模型清单含无效条目".into());
            }
            let mut names = std::collections::HashSet::new();
            let mut total = 0u64;
            for a in &e.files {
                if !basename(&a.name)
                    || !names.insert(&a.name)
                    || a.size == 0
                    || !valid_hash(&a.sha256)
                    || a.chunks.is_empty()
                {
                    return Err("模型清单含无效文件".into());
                }
                total = total.checked_add(a.size).ok_or("模型大小溢出")?;
                let mut offset = 0u64;
                for c in &a.chunks {
                    if c.offset != offset
                        || c.size == 0
                        || c.size > 256 * 1024 * 1024
                        || !valid_hash(&c.sha256)
                    {
                        return Err("模型清单分块范围无效".into());
                    }
                    offset = offset.checked_add(c.size).ok_or("分块大小溢出")?;
                    if offset > a.size {
                        return Err("分块超出文件".into());
                    }
                    for source in &c.sources {
                        let url = reqwest::Url::parse(&source.url).map_err(|_| "模型地址无效")?;
                        let test_local = cfg!(test)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1");
                        if !basename(&source.id)
                            || (!test_local && url.scheme() != "https")
                            || url.host_str().is_none()
                            || !url.username().is_empty()
                            || url.password().is_some()
                        {
                            return Err("模型地址必须使用 HTTPS".into());
                        }
                    }
                    if e.enabled && c.sources.is_empty() {
                        return Err("已启用模型缺少下载源".into());
                    }
                }
                if offset != a.size {
                    return Err("分块未覆盖完整文件".into());
                }
            }
            if total > 32 * 1024 * 1024 * 1024 {
                return Err("模型超出允许大小".into());
            }
        }
        Ok(())
    }
}
