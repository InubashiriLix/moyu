use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8};
use percent_encoding::percent_decode_str;
use roxmltree::Document;
use scraper::{Html, Node, Selector};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read};
use zip::ZipArchive;

const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_EXPANDED: usize = 100 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub path: String,
    pub title: String,
    pub encoding: String,
    pub chapters: Vec<Chapter>,
}

pub fn open(path: &str, encoding: Option<&str>) -> Result<Book, String> {
    let path = fs::canonicalize(path).map_err(|_| "文件不存在或无法访问，请重新选择。")?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err("请选择不超过 64 MB 的 TXT / EPUB 文件。".into());
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let path_string = path.to_string_lossy().into_owned();
    let id = format!("{:x}", Sha256::digest(path_string.as_bytes()));
    let fallback = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    let (title, encoding, chapters) = match extension.as_str() {
        "txt" => {
            let (text, encoding) = decode_text(&bytes, encoding)?;
            let chapters = txt_chapters(&text, &fallback);
            (fallback, encoding, chapters)
        }
        "epub" => {
            let (title, chapters) = read_epub(&bytes, &fallback)?;
            (title, "EPUB".into(), chapters)
        }
        _ => return Err("目前支持 .txt 和 .epub 文件。".into()),
    };
    if chapters.is_empty() || chapters.iter().all(|c| c.text.trim().is_empty()) {
        return Err("这本书没有可读取的文字，或使用了不支持的加密格式。".into());
    }
    Ok(Book {
        id,
        path: path_string,
        title,
        encoding,
        chapters,
    })
}

pub fn decode_text(bytes: &[u8], requested: Option<&str>) -> Result<(String, String), String> {
    let (encoding, bom) = if let Some(label) = requested.filter(|s| *s != "auto") {
        let enc = match label.to_ascii_lowercase().as_str() {
            "utf-8" => UTF_8,
            "utf-16le" => UTF_16LE,
            "utf-16be" => UTF_16BE,
            "gb18030" => GB18030,
            _ => return Err("不支持的编码。".into()),
        };
        let bom = Encoding::for_bom(bytes)
            .filter(|(e, _)| *e == enc)
            .map_or(0, |(_, n)| n);
        (enc, bom)
    } else if let Some(pair) = Encoding::for_bom(bytes) {
        pair
    } else {
        let sample = &bytes[..bytes.len().min(4096)];
        let even_nuls = sample.iter().step_by(2).filter(|b| **b == 0).count();
        let odd_nuls = sample
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|b| **b == 0)
            .count();
        if odd_nuls > sample.len() / 8 && even_nuls * 3 < odd_nuls {
            (UTF_16LE, 0)
        } else if even_nuls > sample.len() / 8 && odd_nuls * 3 < even_nuls {
            (UTF_16BE, 0)
        } else if std::str::from_utf8(bytes).is_ok() {
            (UTF_8, 0)
        } else {
            (GB18030, 0)
        }
    };
    let (text, errors) = encoding.decode_without_bom_handling(&bytes[bom..]);
    if errors {
        return Err("无法可靠识别文本编码，请在打开文件前选择 UTF-8、UTF-16 或 GB18030。".into());
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    Ok((
        text.trim_start_matches('\u{feff}').to_owned(),
        encoding.name().into(),
    ))
}

fn is_heading(line: &str) -> bool {
    let s = line.trim();
    if s.chars().count() > 60 || s.is_empty() {
        return false;
    }
    (s.starts_with('第') && ["章", "回", "节", "卷"].iter().any(|unit| s.contains(unit)))
        || s.to_lowercase().starts_with("chapter ")
}

fn txt_chapters(text: &str, title: &str) -> Vec<Chapter> {
    let mut chapters = Vec::new();
    let mut name = title.to_owned();
    let mut body = String::new();
    for line in text.lines() {
        if is_heading(line) {
            if !body.trim().is_empty() {
                chapters.push(Chapter {
                    id: chapters.len().to_string(),
                    title: name,
                    text: body.trim().into(),
                });
            }
            name = line.trim().into();
            body = String::new();
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    if !body.trim().is_empty() {
        chapters.push(Chapter {
            id: chapters.len().to_string(),
            title: name,
            text: body.trim().into(),
        });
    }
    chapters
}

fn resource_path(base: &str, href: &str) -> Result<String, String> {
    let href = href
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    let decoded = percent_decode_str(href)
        .decode_utf8()
        .map_err(|_| "EPUB 路径编码无效。")?;
    if decoded.contains(':') || decoded.starts_with('/') || decoded.contains('\\') {
        return Err("EPUB 包含不支持的外部资源路径。".into());
    }
    let mut parts: Vec<&str> = base
        .rsplit_once('/')
        .map_or("", |(p, _)| p)
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or("EPUB 资源路径超出书籍目录。")?;
            }
            _ => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

fn entry(
    archive: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    path: &str,
    budget: &mut usize,
) -> Result<String, String> {
    let mut file = archive
        .by_name(path)
        .map_err(|_| format!("EPUB 缺少资源：{path}"))?;
    let size = file.size() as usize;
    if size > *budget {
        return Err("EPUB 解压后过大（上限 100 MB）。".into());
    }
    let mut bytes = Vec::with_capacity(size);
    (&mut file)
        .take((*budget + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 EPUB 失败：{e}"))?;
    if bytes.len() > *budget {
        return Err("EPUB 解压后过大。".into());
    }
    *budget -= bytes.len();
    // EPUB XML/XHTML uses UTF-8 or a BOM-declared UTF-16 encoding.
    decode_text(&bytes, None).map(|(text, _)| text)
}

fn xml<'a>(source: &'a str) -> Result<Document<'a>, String> {
    Document::parse(source).map_err(|e| format!("EPUB 结构损坏：{e}"))
}

fn plain_html(source: &str) -> (String, String) {
    let html = Html::parse_document(source);
    let heading = Selector::parse("h1, h2, h3").unwrap();
    let title = html
        .select(&heading)
        .next()
        .map(|el| el.text().collect::<String>())
        .unwrap_or_default();
    let root = Selector::parse("body").unwrap();
    let root = html
        .select(&root)
        .next()
        .unwrap_or_else(|| html.root_element());
    let forbidden = [
        "script", "style", "noscript", "iframe", "object", "svg", "head", "nav",
    ];
    let block = [
        "p",
        "div",
        "section",
        "article",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "blockquote",
        "br",
        "tr",
    ];
    let mut result = String::new();
    for edge in root.traverse() {
        let node = match edge {
            ego_tree::iter::Edge::Open(node) => node,
            ego_tree::iter::Edge::Close(node) => {
                if let Node::Element(el) = node.value() {
                    if block.contains(&el.name()) {
                        result.push('\n');
                    }
                }
                continue;
            }
        };
        if node
            .ancestors()
            .chain(std::iter::once(node))
            .any(|n| match n.value() {
                Node::Element(el) => forbidden.contains(&el.name()) || el.attr("hidden").is_some(),
                _ => false,
            })
        {
            continue;
        }
        match node.value() {
            Node::Text(text) => {
                // Collapse HTML whitespace without joining adjacent CJK text nodes.
                let mut space = false;
                for ch in text.chars() {
                    if ch.is_whitespace() {
                        space = true;
                    } else {
                        if space && !result.is_empty() && !result.ends_with(['\n', ' ']) {
                            result.push(' ');
                        }
                        result.push(ch);
                        space = false;
                    }
                }
                if space && !result.ends_with(['\n', ' ']) {
                    result.push(' ');
                }
            }
            Node::Element(el) if block.contains(&el.name()) => result.push('\n'),
            _ => {}
        }
    }
    let text = result
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (title.trim().to_owned(), text)
}

fn read_epub(bytes: &[u8], fallback: &str) -> Result<(String, Vec<Chapter>), String> {
    let mut archive =
        ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "这不是有效的 EPUB 文件。")?;
    let mut budget = MAX_EXPANDED;
    if let Ok(encryption) = archive.by_name("META-INF/encryption.xml") {
        let mut text = String::new();
        encryption
            .take(1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|_| "无法读取 EPUB 加密信息。")?;
        if text.contains("EncryptedData") && !text.contains("http://www.idpf.org/2008/embedding") {
            return Err("暂不支持 DRM 加密 EPUB。".into());
        }
    }
    let container = entry(&mut archive, "META-INF/container.xml", &mut budget)?;
    let container = xml(&container)?;
    let package_path = container
        .descendants()
        .find(|n| n.has_tag_name("rootfile"))
        .and_then(|n| n.attribute("full-path"))
        .ok_or("EPUB 缺少主目录。")?;
    let package_path = resource_path("", package_path)?;
    let package = entry(&mut archive, &package_path, &mut budget)?;
    let package = xml(&package)?;
    let title = package
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "title")
        .and_then(|n| n.text())
        .unwrap_or(fallback)
        .trim()
        .to_owned();
    let mut manifest = HashMap::new();
    let mut nav_path = None;
    let mut ncx_path = None;
    for item in package.descendants().filter(|n| n.has_tag_name("item")) {
        if let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) {
            let path = resource_path(&package_path, href)?;
            if item
                .attribute("properties")
                .unwrap_or("")
                .split_whitespace()
                .any(|s| s == "nav")
            {
                nav_path = Some(path.clone());
            }
            if item.attribute("media-type") == Some("application/x-dtbncx+xml") {
                ncx_path = Some(path.clone());
            }
            manifest.insert(id.to_owned(), path);
        }
    }
    let mut labels = HashMap::new();
    if let Some(path) = nav_path {
        let source = entry(&mut archive, &path, &mut budget)?;
        let html = Html::parse_document(&source);
        let selector = Selector::parse("nav a[href]").unwrap();
        for a in html.select(&selector) {
            if let Some(href) = a.value().attr("href") {
                if let Ok(target) = resource_path(&path, href) {
                    labels
                        .entry(target)
                        .or_insert_with(|| a.text().collect::<String>().trim().to_owned());
                }
            }
        }
    } else if let Some(path) = ncx_path {
        let source = entry(&mut archive, &path, &mut budget)?;
        let doc = xml(&source)?;
        for point in doc.descendants().filter(|n| n.has_tag_name("navPoint")) {
            let label = point
                .children()
                .find(|n| n.has_tag_name("navLabel"))
                .and_then(|n| n.descendants().find(|n| n.has_tag_name("text")))
                .and_then(|n| n.text());
            let href = point
                .children()
                .find(|n| n.has_tag_name("content"))
                .and_then(|n| n.attribute("src"));
            if let (Some(label), Some(href)) = (label, href) {
                labels
                    .entry(resource_path(&path, href)?)
                    .or_insert_with(|| label.trim().into());
            }
        }
    }
    let mut chapters = Vec::new();
    for item in package
        .descendants()
        .filter(|n| n.has_tag_name("itemref") && n.attribute("linear") != Some("no"))
    {
        let id = item.attribute("idref").ok_or("EPUB 章节索引缺失。")?;
        let path = manifest.get(id).ok_or("EPUB 章节资源缺失。")?;
        let source = entry(&mut archive, path, &mut budget)?;
        let (heading, text) = plain_html(&source);
        if text.is_empty() {
            continue;
        }
        let name = labels
            .get(path)
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if !heading.is_empty() {
                    heading
                } else {
                    format!("第 {} 节", chapters.len() + 1)
                }
            });
        chapters.push(Chapter {
            id: path.clone(),
            title: name,
            text,
        });
    }
    Ok((title, chapters))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[test]
    fn opens_external_epub_when_requested() {
        let Ok(path) = std::env::var("MOYU_TEST_EPUB") else {
            return;
        };
        let book = open(&path, None).unwrap();
        assert_eq!(book.encoding, "EPUB");
        assert!(!book.chapters.is_empty());
        assert!(book.chapters.iter().all(|c| !c.text.trim().is_empty()));
        println!(
            "Parsed external EPUB: {} chapters, {} characters",
            book.chapters.len(),
            book.chapters
                .iter()
                .map(|c| c.text.chars().count())
                .sum::<usize>()
        );
    }

    #[test]
    fn decodes_chinese_encodings_and_rejects_bad_override() {
        let text = "第一章 开始\r\n你好，世界。";
        assert_eq!(
            decode_text(text.as_bytes(), None).unwrap().0,
            text.replace("\r\n", "\n")
        );
        let (gb, _, _) = GB18030.encode(text);
        assert_eq!(decode_text(&gb, None).unwrap().1, "gb18030");
        assert!(decode_text(&gb, Some("utf-8")).is_err());
        for big_endian in [false, true] {
            let mut bytes = if big_endian {
                vec![0xfe, 0xff]
            } else {
                vec![0xff, 0xfe]
            };
            for code in text.encode_utf16() {
                bytes.extend(if big_endian {
                    code.to_be_bytes()
                } else {
                    code.to_le_bytes()
                });
            }
            assert!(decode_text(&bytes, None).unwrap().0.contains("你好"));
        }
    }

    #[test]
    fn detects_txt_chapters_without_losing_preamble() {
        let chapters = txt_chapters("序言\n\n第一章 初见\n你好\n第二章 再见\n世界", "小说");
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].text, "序言");
        assert_eq!(chapters[2].title, "第二章 再见");
    }

    #[test]
    fn html_keeps_paragraphs_but_drops_active_content() {
        let (_, text) = plain_html("<body><h1>标题</h1><p>你好<strong>世界</strong></p><script>alert('bad')</script><iframe>bad</iframe><p hidden>秘密</p><p>下一段<br>另起一行</p></body>");
        assert!(text.contains("你好世界"));
        assert!(text.contains("下一段\n\n另起一行"));
        assert!(!text.contains("bad") && !text.contains("秘密"));
    }

    #[test]
    fn epub_uses_spine_order_and_navigation_names() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let files = [
            ("META-INF/container.xml", "<container><rootfiles><rootfile full-path='OPS/book.opf'/></rootfiles></container>"),
            ("OPS/book.opf", "<package><metadata><title>测试书</title></metadata><manifest><item id='a' href='a.xhtml'/><item id='b' href='b.xhtml'/><item id='nav' href='nav.xhtml' properties='nav'/></manifest><spine><itemref idref='b'/><itemref idref='a'/></spine></package>"),
            ("OPS/nav.xhtml", "<html><body><nav><a href='a.xhtml'>第一节</a><a href='b.xhtml'>第二节</a></nav></body></html>"),
            ("OPS/a.xhtml", "<p>甲内容</p>"),
            ("OPS/b.xhtml", "<p>乙内容</p><script>remote()</script>"),
        ];
        for (name, content) in files {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let (title, chapters) = read_epub(&bytes, "fallback").unwrap();
        assert_eq!(title, "测试书");
        assert_eq!(chapters[0].title, "第二节");
        assert_eq!(chapters[1].text, "甲内容");
        assert!(!chapters[0].text.contains("remote"));
    }

    #[test]
    fn resource_paths_are_local_and_normalized() {
        assert_eq!(
            resource_path("OPS/book.opf", "Text/%E4%B8%AD.xhtml#x").unwrap(),
            "OPS/Text/中.xhtml"
        );
        assert!(resource_path("OPS/book.opf", "../../outside").is_err());
        assert!(resource_path("OPS/book.opf", "https://example.com").is_err());
    }
}
