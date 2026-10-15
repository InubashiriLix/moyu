#!/usr/bin/env python3
"""Export chunked, hostable model/backend artifacts plus a catalog description.

By default the script downloads nothing and never invents a mirror URL: it
slices files that already exist locally into chunks (streaming, so a
multi-gigabyte GGUF is never loaded into RAM) and records the integrity record
for every file and every chunk. Every configured base must be an HTTPS URL.

A catalog entry is only marked ``enabled`` when the operator configured at least
two HTTPS mirrors *and* passed ``--enable-sources``. That flag performs a real
network verification of every unique chunk source (HEAD size plus a 206 range
bytes/hash check) before anything is enabled; if any source fails verification
the catalog is refused. The full-file hash check of the hosted source remains the
release process's responsibility. Without the flag the catalog is produced with
``enabled=false`` so it can be reviewed.

Only real GGUF artifacts are hosted. The official Qwen ``safetensors``
repository is explicitly rejected as a source.
"""
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import json
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import quote, urlparse

from stage_voice import sha

CHUNK_SIZE = 256 * 1024 * 1024
SCHEMA_VERSION = 1

# The two GGUF variants that the catalog can describe. Both reference the same
# tokenizer artifact, which is exported once.
VARIANT_IDS = {
    'f16': 'qwen3-tts-1.7b-customvoice-f16',
    'q5_k': 'qwen3-tts-1.7b-customvoice-q5_k',
    'q5_0': 'qwen3-tts-1.7b-customvoice-q5_0',
}
VARIANT_LABELS = {
    'f16': 'Qwen3-TTS 1.7B CustomVoice (F16)',
    'q5_k': 'Qwen3-TTS 1.7B CustomVoice (Q5_K)',
    'q5_0': 'Qwen3-TTS 1.7B CustomVoice (Q5_0)',
}
# Quantised builds are informative but never the reviewed default.
EXPERIMENTAL_VARIANTS = frozenset({'q5_0', 'q5_k'})
SOURCE_IDS = ('huggingface', 'hf-mirror', 'github', 'modelscope')

# Never treat the upstream safetensors repository as a GGUF source.
OFFICIAL_SAFETENSORS = re.compile(r'(^|//|\.)huggingface\.co/Qwen', re.IGNORECASE)

SAFE_NAME = re.compile(r'^[A-Za-z0-9._+-]+$')
# A revision recorded in the catalog must be a non-empty, URL-safe basename.
SAFE_REVISION = re.compile(r'^[A-Za-z0-9._+-]{1,200}$')
# Component (CUDA) payload whitelist: our worker, GGML libraries and the
# redistributable NVIDIA runtime libraries. Headers, static archives, JSON and
# anything else are refused so an accidental directory is never published.
COMPONENT_FILE = re.compile(r'^(nv-worker|lib[A-Za-z0-9_+.\-]*\.so(\.[0-9]+)*)$')
COMPONENT_LICENSES = {'Qwen3-cpp-Apache-2.0.txt', 'GGML-MIT.txt', 'NVIDIA-CUDA-EULA.txt'}


class ExportError(RuntimeError):
    pass


def is_official_safetensors(base):
    return bool(OFFICIAL_SAFETENSORS.search(base))


def _normalise_base(value, name):
    if not value:
        return None
    base = value.strip().rstrip('/')
    if not base:
        return None
    if not base.lower().startswith('https://') or not urlparse(base).netloc:
        raise ExportError(f'{name} must be an absolute HTTPS URL, got: {value!r}')
    if is_official_safetensors(base):
        raise ExportError(
            f'{name} points at the official Qwen safetensors repository; that is '
            'not a GGUF mirror and must not be published as a source')
    return base


def collect_bases(args):
    """Return the configured mirror bases, keyed by channel id."""
    bases = {}
    for channel, value in (('github', args.github_base),
                           ('huggingface', args.huggingface_base),
                           ('hf-mirror', args.hf_mirror_base),
                           ('modelscope', args.modelscope_base)):
        base = _normalise_base(value, channel)
        if base:
            bases[channel] = base
    return bases


def chunk_sources(bases, chunk_name, enabled):
    """Build the ``sources`` list for one chunk; empty when nothing configured."""
    quoted = quote(chunk_name, safe='')
    sources = []
    for channel in SOURCE_IDS:
        base = bases.get(channel)
        if base:
            sources.append({'id': channel, 'url': f'{base}/{quoted}', 'enabled': enabled})
    return sources


def stream_chunks(source, output, bases, enabled, chunk_size=CHUNK_SIZE, prefix=None):
    """Slice ``source`` into chunks, returning (size, sha256, [chunk, ...]).

    Each byte is read exactly once: it feeds the per-chunk hash, the whole-file
    hash and the on-disk chunk. No file is ever materialised in memory.
    ``prefix`` lets callers keep flat chunk filenames collision-free.
    """
    _validate_chunk_size(chunk_size)
    size = source.stat().st_size
    output.mkdir(parents=True, exist_ok=True)
    file_digest = hashlib.sha256()
    chunks = []
    offset = 0
    index = 0
    with source.open('rb') as stream:
        while offset < size:
            remaining = min(chunk_size, size - offset)
            name = f'{(prefix or source.name)}.chunk{index:03d}'
            target = output / name
            if target.exists():
                raise ExportError(f'refusing to overwrite existing chunk: {target}')
            chunk_digest = hashlib.sha256()
            written = 0
            with target.open('wb') as sink:
                while remaining:
                    block = stream.read(min(8 * 1024 * 1024, remaining))
                    if not block:
                        raise ExportError(f'{source} ended early at offset {offset + written}')
                    sink.write(block)
                    chunk_digest.update(block)
                    file_digest.update(block)
                    written += len(block)
                    remaining -= len(block)
            chunks.append({
                'name': name,
                'offset': offset,
                'size': written,
                'sha256': chunk_digest.hexdigest(),
                'sources': chunk_sources(bases, name, enabled),
            })
            offset += written
            index += 1
    return size, file_digest.hexdigest(), chunks


def export_artifact(source, output, bases, enabled, expected=None, chunk_size=CHUNK_SIZE, prefix=None):
    """Export one file, verifying its size/hash against the manifest when given."""
    if not source.is_file():
        raise ExportError(f'missing artifact: {source}')
    if not SAFE_NAME.match(source.name):
        raise ExportError(f'unsafe artifact name: {source.name}')
    size, digest, chunks = stream_chunks(source, output, bases, enabled, chunk_size, prefix=prefix)
    if expected:
        if expected.get('size') is not None and expected['size'] != size:
            raise ExportError(
                f'{source.name} size {size} != manifest {expected["size"]}')
        if expected.get('sha256') and expected['sha256'] != digest:
            raise ExportError(
                f'{source.name} sha256 {digest} != manifest {expected["sha256"]}')
    return {'name': source.name, 'size': size, 'sha256': digest, 'chunks': chunks}


def variant_of(row):
    """Classify a manifest artifact into tokenizer / f16 / q5_k."""
    name = row.get('file', '')
    kind = str(row.get('kind', '')).lower()
    if 'tokenizer' in name.lower():
        return 'tokenizer'
    for token, variant in (('q5_k', 'q5_k'), ('q5k', 'q5_k'),
                           ('q5_0', 'q5_0'), ('q50', 'q5_0')):
        if token in name.lower() or token in kind:
            return variant
    if 'f16' in kind or 'f16' in name.lower() or 'fp16' in name.lower():
        return 'f16'
    return None


def safe_revision(value):
    """Return a non-empty, URL-safe basename for a revision, else ``None``."""
    if value is None:
        return None
    text = str(value).strip().rstrip('/')
    if not text:
        return None
    text = text.split('/')[-1]
    return text if SAFE_REVISION.match(text) else None


def model_revision(manifest, needles):
    """Resolve a real, non-empty revision from ``manifest['revisions']``.

    The value is normalised to a safe basename. If no needle matches, the first
    usable *actual* manifest revision is used as a fallback; ``None`` is only
    returned when the manifest carries no usable revision, so we never invent
    one.
    """
    revisions = manifest.get('revisions') or {}
    if isinstance(needles, str):
        needles = (needles,)
    for needle in needles:
        for key, value in revisions.items():
            if needle.lower() in str(key).lower():
                resolved = safe_revision(value)
                if resolved:
                    return resolved
    for value in revisions.values():
        resolved = safe_revision(value)
        if resolved:
            return resolved
    return None


def _validate_chunk_size(chunk_size):
    if not isinstance(chunk_size, int) or isinstance(chunk_size, bool) or chunk_size <= 0:
        raise ExportError(f'chunk size must be a positive integer, got {chunk_size!r}')
    if chunk_size > CHUNK_SIZE:
        raise ExportError(f'chunk size {chunk_size} exceeds the {CHUNK_SIZE} byte maximum')


def build_model_entries(manifest, models_dir, output, bases, enabled, chunk_size):
    artifacts = manifest.get('artifacts') or []
    by_variant = {}
    tokenizer = None
    skipped = []
    for row in artifacts:
        variant = variant_of(row)
        if variant == 'tokenizer':
            tokenizer = row
        elif variant in VARIANT_IDS:
            by_variant[variant] = row
        else:
            skipped.append(row.get('file'))

    exported = {}
    entries = []

    def file_object(row):
        name = row['file']
        if name not in exported:
            exported[name] = export_artifact(
                models_dir / name, output, bases, enabled, expected=row, chunk_size=chunk_size)
        return exported[name]

    if by_variant and tokenizer is None:
        raise ExportError('tokenizer artifact is required but missing from the manifest')
    revision = model_revision(manifest, ('CustomVoice', 'Qwen3-TTS', 'tokenizer'))
    if by_variant and revision is None:
        raise ExportError('manifest has no usable revision; refusing to invent one')

    for variant in VARIANT_IDS:
        row = by_variant.get(variant)
        if row is None:
            print(f'export_model_catalog: no {variant} artifact in manifest; skipping', file=sys.stderr)
            continue
        # Every model entry ships the tokenizer alongside the weights.
        files = [file_object(row), file_object(tokenizer)]
        entries.append({
            'id': VARIANT_IDS[variant],
            'label': VARIANT_LABELS[variant],
            'kind': 'model',
            'variant': variant,
            'revision': revision,
            'enabled': enabled,
            'experimental': variant in EXPERIMENTAL_VARIANTS or bool(row.get('experimental', False)),
            'files': files,
        })
    return entries, skipped


def safe_component_path(path, root):
    """Validate a component file path against traversal and the name whitelist."""
    relative = path.relative_to(root)
    if relative.is_absolute() or not relative.parts:
        raise ExportError(f'unsafe component path: {path}')
    for part in relative.parts[:-1]:
        if part in ('', '.', '..') or not SAFE_NAME.match(part):
            raise ExportError(f'unsafe component directory: {part}')
    name = relative.name
    if name in ('', '.', '..') or not (COMPONENT_FILE.match(name) or name in COMPONENT_LICENSES):
        raise ExportError(f'component file is not whitelisted: {name}')
    return relative


def export_component(directory, output, bases, enabled, revision=None, chunk_size=CHUNK_SIZE):
    """Export a downloadable CUDA component without modifying any binary."""
    if not directory.is_dir():
        raise ExportError(f'component directory not found: {directory}')
    revision = safe_revision(revision)
    if revision is None:
        raise ExportError('component revision must be a non-empty safe basename')
    files = []
    seen = set()
    for path in sorted(directory.rglob('*')):
        if path.name == '.moyu-owned-component': continue
        if path.is_dir():
            continue
        if path.is_symlink():
            raise ExportError(f'refusing symlink in component dir: {path}')
        relative = safe_component_path(path, directory)
        if relative.name in seen:
            raise ExportError(f'component has duplicate file name: {relative.name}')
        seen.add(relative.name)
        # Chunk names are flat, so encode the relative path to stay unique even
        # when two component subdirectories carry the same file name.
        prefix = str(relative).replace('/', '__').replace(os.sep, '__')
        # Bytes are copied verbatim; NVIDIA libraries are never patched.
        expected = {'size': path.stat().st_size, 'sha256': sha(path)}
        files.append(export_artifact(path, output, bases, enabled,
                                     expected=expected, chunk_size=chunk_size,
                                     prefix=prefix))
    entry = {
        'id': 'cuda-linux-x86_64-abi1',
        'label': 'CUDA backend (linux-x86_64, engine ABI 1)',
        'kind': 'backend',
        'variant': 'cuda',
        'revision': safe_revision(revision),
        'enabled': enabled,
        'experimental': True,
        'files': files,
    }
    return entry


def sha_prefix(path, size):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        digest.update(stream.read(size))
    return digest.hexdigest()


def verify_source(url, chunk, local, timeout, probe=64 * 1024):
    """Verify one hosted chunk source over HTTPS.

    Requires a HEAD whose Content-Length matches the chunk size and a range
    request that actually returns 206 with bytes hashing to the local chunk's
    prefix. This is the minimum real check; the parent release process still
    owns the whole-file hash check of the published object.
    """
    if urlparse(url).scheme != 'https':
        raise ExportError(f'refusing non-HTTPS source: {url}')
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'),
                                    timeout=timeout) as response:
            if response.status not in (200, 204):
                raise ExportError(f'HEAD {url} returned {response.status}')
            length = response.headers.get('Content-Length')
    except urllib.error.URLError as error:
        raise ExportError(f'HEAD {url} failed: {error}')
    if length is None:
        raise ExportError(f'HEAD {url} did not report a Content-Length')
    if int(length) != chunk['size']:
        raise ExportError(f'{url} size {length} != chunk size {chunk["size"]}')
    size = min(probe, chunk['size'])
    try:
        with urllib.request.urlopen(urllib.request.Request(
                url, headers={'Range': f'bytes=0-{size - 1}'}), timeout=timeout) as response:
            if response.status != 206:
                raise ExportError(f'range request on {url} returned {response.status}, expected 206')
            body = response.read(size + 1)
    except urllib.error.URLError as error:
        raise ExportError(f'range request on {url} failed: {error}')
    if len(body) != size:
        raise ExportError(f'{url} returned {len(body)} ranged bytes, expected {size}')
    if hashlib.sha256(body).hexdigest() != sha_prefix(local, size):
        raise ExportError(f'{url} ranged bytes do not match the local chunk prefix')


def verify_entries(output, entries, timeout):
    """Verify every unique chunk source once; return the set of verified URLs."""
    from concurrent.futures import ThreadPoolExecutor
    pending = {}
    for entry in entries:
        for file_row in entry['files']:
            for chunk in file_row['chunks']:
                local = output / chunk['name']
                for source in chunk['sources']:
                    pending[source['url']] = (chunk, local)
    def check(url):
        chunk, local = pending[url]
        import time
        for attempt in range(3):
            try:
                verify_source(url, chunk, local, timeout)
                return url
            except ExportError:
                if attempt == 2: raise
                time.sleep(2)
    with ThreadPoolExecutor(max_workers=4) as pool:
        return set(pool.map(check, pending))


def write_catalog(path, entries):
    catalog = {
        'schemaVersion': SCHEMA_VERSION,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'entries': entries,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')


def export(args):
    _validate_chunk_size(args.chunk_size)
    bases = collect_bases(args)
    if args.enable_sources and len(bases) < 2:
        raise ExportError(
            '--enable-sources requires at least two configured HTTPS mirrors so '
            'the release process can verify a fallback channel')
    enabled = False

    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    entries = []
    if args.existing_catalog:
        entries = json.loads(args.existing_catalog.read_text())['entries']
        checked = set()
        for entry in entries:
            entry['enabled'] = False
            for artifact in entry['files']:
                for chunk in artifact['chunks']:
                    name = chunk['name']
                    if not SAFE_NAME.fullmatch(name) or name.startswith('.'):
                        raise ExportError('unsafe chunk name in existing catalog')
                    local = output / name
                    if name not in checked:
                        if local.stat().st_size != chunk['size'] or sha(local) != chunk['sha256']:
                            raise ExportError('existing chunk failed integrity verification')
                        checked.add(name)
                    chunk['sources'] = chunk_sources(bases, name, False)

    if args.models_dir is not None:
        manifest_path = args.models_dir / 'manifest.json'
        if not manifest_path.is_file():
            raise ExportError(f'manifest not found: {manifest_path}')
        manifest = json.loads(manifest_path.read_text())
        model_entries, skipped = build_model_entries(
            manifest, args.models_dir, output, bases, enabled, args.chunk_size)
        entries.extend(model_entries)
        if skipped:
            print('export_model_catalog: ignored unrelated artifacts: '
                  + ', '.join(str(name) for name in skipped), file=sys.stderr)
    if args.component_dir is not None:
        entries.append(export_component(
            args.component_dir, output, bases, enabled,
            revision=args.component_revision, chunk_size=args.chunk_size))
    if not entries:
        raise ExportError('nothing to export: provide --models-dir and/or --component-dir')

    if args.enable_sources:
        # Only mark sources enabled after each unique chunk source is really
        # reachable and consistent; two bare URL strings are not enough.
        verified = verify_entries(output, entries, args.verify_timeout)
        hosts = {urlparse(url).netloc for url in verified}
        if len(hosts) < 2:
            raise ExportError('fewer than two distinct HTTPS channels verified; refusing to enable')
        for entry in entries:
            entry['enabled'] = True
            for file_row in entry['files']:
                for chunk in file_row['chunks']:
                    for source in chunk['sources']:
                        source['enabled'] = source['url'] in verified
        enabled = True

    catalog_path = args.catalog or (output / 'catalog.json')
    write_catalog(catalog_path, entries)
    summary = {
        'catalog': str(catalog_path),
        'output': str(output),
        'enabled': enabled,
        'sources': sorted(bases),
        'entries': [entry['id'] for entry in entries],
        'chunks': sum(len(f['chunks']) for entry in entries for f in entry['files']),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models-dir', type=Path,
                        help='directory holding *.gguf and manifest.json')
    parser.add_argument('--existing-catalog', type=Path, help='reuse and verify already exported chunks')
    parser.add_argument('--output', type=Path, required=True,
                        help='directory that receives the chunk files')
    parser.add_argument('--catalog', type=Path,
                        help='catalog JSON path (default: <output>/catalog.json)')
    parser.add_argument('--github-base')
    parser.add_argument('--huggingface-base')
    parser.add_argument('--hf-mirror-base', help='verified alternate HF network gateway; shares upstream storage')
    parser.add_argument('--modelscope-base')
    parser.add_argument('--enable-sources', action='store_true',
                        help='mark sources enabled; requires two verified mirrors')
    parser.add_argument('--component-dir', type=Path,
                        help='CUDA component directory to export as a backend entry')
    parser.add_argument('--component-revision')
    parser.add_argument('--chunk-size', type=int, default=CHUNK_SIZE)
    parser.add_argument('--verify-timeout', type=float, default=30.0,
                        help='per-request timeout (seconds) used by --enable-sources')
    args = parser.parse_args(argv)
    try:
        export(args)
    except ExportError as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
