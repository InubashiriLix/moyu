//! 单分块顺序下载：Range 续传 + 校验友好的写入定位。
//!
//! 生产环境使用 HTTPS；测试允许 localhost 明文 HTTP。网络超时与重定向
//! 均由调用方提供的 `reqwest::blocking::Client` 统一配置。

use std::io::{Read, Seek, SeekFrom, Write};

use reqwest::header::{HeaderMap, ACCEPT_ENCODING, CONTENT_RANGE, ETAG, IF_RANGE, RANGE};
use reqwest::StatusCode;

use super::schema::Chunk;

/// 每次读写使用的缓冲大小。
const BUFFER: usize = 64 * 1024;

/// 将一个分块下载到 `file`，写入位置为 `chunk.offset + received`。
///
/// * `received` 为该分块已成功落盘的字节数（续传起点）。
/// * `etag` 为上次记录的强 ETag；仅当同源且为强 ETag 时才发送 `If-Range`。
/// * `progress` 每累计 64 KiB 通知一次当前分块的接收量与该响应的强 ETag，
///   回调返回错误时立即中止下载。
pub fn transfer(
    client: &reqwest::blocking::Client,
    url: &str,
    file: &mut std::fs::File,
    chunk: &Chunk,
    received: u64,
    etag: Option<&str>,
    progress: &mut dyn FnMut(u64, Option<String>) -> Result<(), String>,
) -> Result<(), String> {
    if received > chunk.size {
        return Err("已接收字节超出分块大小".into());
    }

    let mut request = client.get(url).header(ACCEPT_ENCODING, "identity");
    if received > 0 {
        request = request.header(RANGE, format!("bytes={}-", received));
        if let Some(tag) = etag.filter(|value| is_strong_etag(value)) {
            request = request.header(IF_RANGE, tag);
        }
    }

    let response = request
        .send()
        .map_err(|_| "请求下载失败，请检查网络或切换下载源".to_owned())?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        // 已完整落盘，交由外层核验哈希。
        return if received == chunk.size {
            Ok(())
        } else {
            Err("服务器拒绝请求的分块范围".into())
        };
    }

    let start = match status {
        StatusCode::PARTIAL_CONTENT => {
            let value = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .ok_or("缺少 Content-Range 响应头")?;
            let (range_start, range_end, total) =
                parse_content_range(value).ok_or("Content-Range 响应头无效")?;
            if range_start != received || total != chunk.size || range_end != chunk.size - 1 {
                return Err("服务器返回的分块范围与请求不符".into());
            }
            received
        }
        // 服务器忽略了 Range：从本分块起点整体重写，绝不截断整个文件。
        StatusCode::OK => 0,
        _ => return Err(format!("下载返回异常状态码 {}", status.as_u16())),
    };

    let response_etag = strong_etag(response.headers());

    let mut received = start;
    progress(start, response_etag.clone())?;
    file.seek(SeekFrom::Start(chunk.offset + received))
        .map_err(|err| format!("定位写入位置失败: {err}"))?;

    let mut reader = response;
    let mut buffer = vec![0u8; BUFFER];
    let mut notified = received;

    loop {
        let remaining = chunk.size - received;
        if remaining == 0 {
            break;
        }
        let want = remaining.min(BUFFER as u64) as usize;
        let read = reader
            .read(&mut buffer[..want])
            .map_err(|_| "网络连接中断，保留已下载部分".to_owned())?;
        if read == 0 {
            return Err("下载数据提前结束".into());
        }
        file.write_all(&buffer[..read])
            .map_err(|err| format!("写入文件失败: {err}"))?;
        received += read as u64;
        if received > notified {
            progress(received, response_etag.clone())?;
            notified = received;
        }
    }

    if received > notified {
        progress(received, response_etag.clone())?;
    }
    Ok(())
}

fn is_strong_etag(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"')
}

fn strong_etag(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(ETAG)?.to_str().ok()?;
    if is_strong_etag(value) {
        Some(value.trim().to_string())
    } else {
        None
    }
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((
        start.trim().parse().ok()?,
        end.trim().parse().ok()?,
        total.trim().parse().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn chunk(offset: u64, size: u64) -> Chunk {
        Chunk {
            offset,
            size,
            sha256: String::new(),
            sources: Vec::new(),
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut path = std::env::temp_dir();
        path.push(format!("transport-{}-{}-{}", std::process::id(), name, n));
        path
    }

    fn open(path: &PathBuf) -> std::fs::File {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap()
    }

    fn read_all(path: &PathBuf) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    /// 启动一次性 mock 服务器，返回 URL 与读取到的请求行句柄。
    fn serve(
        status: &'static str,
        headers: Vec<String>,
        body: Vec<u8>,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}/chunk");
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            loop {
                let mut line = String::new();
                let n = reader.read_line(&mut line).unwrap();
                if n == 0 || line == "\r\n" || line == "\n" {
                    break;
                }
                request_line.push_str(&line);
            }
            let mut out = stream;
            let mut head = format!("HTTP/1.1 {status}\r\n");
            for header in &headers {
                head.push_str(header);
                head.push_str("\r\n");
            }
            head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
            out.write_all(head.as_bytes()).unwrap();
            out.write_all(&body).unwrap();
            out.flush().unwrap();
            request_line
        });
        (url, handle)
    }

    fn client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder().build().unwrap()
    }

    fn noop_progress() -> impl FnMut(u64, Option<String>) -> Result<(), String> {
        |_bytes, _etag| Ok(())
    }
    #[allow(unused_imports)]
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn range_answered_with_200_rewrites_only_this_chunk() {
        let path = temp_file("rewrite");
        let mut file = open(&path);
        // 预置两个分块：前块全 0x11，后块前 4 字节为 0xBB。
        let mut initial = vec![0x11u8; 8];
        initial.extend([0xBB; 16]);
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&initial).unwrap();
        file.flush().unwrap();

        let body = vec![0x22u8; 16];
        let (url, handle) = serve("200 OK", vec![], body.clone());
        let ch = chunk(8, 16);
        let mut progress = noop_progress();
        let outcome = transfer(
            &client(),
            &url,
            &mut file,
            &ch,
            4,
            Some("\"abc\""),
            &mut progress,
        );
        assert!(outcome.is_ok(), "{outcome:?}");
        let request = handle.join().unwrap();
        assert!(request.contains("bytes=4-"), "未请求续传: {request}");

        let data = read_all(&path);
        assert_eq!(&data[0..8], &[0x11u8; 8], "前块被破坏");
        assert_eq!(&data[8..24], body.as_slice());
    }

    #[test]
    fn partial_content_with_wrong_range_is_rejected() {
        let path = temp_file("badrange");
        let mut file = open(&path);
        file.set_len(1024).unwrap();

        let body = vec![0x33u8; 16];
        let headers = vec!["Content-Range: bytes 999-1014/1024".to_string()];
        let (url, handle) = serve("206 Partial Content", headers, body);
        let ch = chunk(0, 1024);
        let mut progress = noop_progress();
        let outcome = transfer(&client(), &url, &mut file, &ch, 0, None, &mut progress);
        assert!(outcome.is_err());
        let _ = handle.join().unwrap();
        assert_eq!(file.metadata().unwrap().len(), 1024);
    }

    #[test]
    fn short_body_keeps_partial_data_and_errors() {
        let path = temp_file("short");
        let mut file = open(&path);
        file.set_len(16).unwrap();

        let body = vec![0x44u8; 8];
        let (url, handle) = serve("200 OK", vec![], body.clone());
        let ch = chunk(0, 16);
        let mut progress = noop_progress();
        let outcome = transfer(&client(), &url, &mut file, &ch, 0, None, &mut progress);
        assert!(outcome.is_err());
        let _ = handle.join().unwrap();

        let data = read_all(&path);
        assert_eq!(data.len(), 16, "文件被截断");
        assert_eq!(&data[0..8], body.as_slice());
    }
}
