#!/usr/bin/env python3
"""Cloudflare Pages Direct Upload —— 部署到 Pages 项目

用法:
    CF_TOKEN=xxx python3 deploy_pages.py <ACCOUNT_ID> <PROJECT_NAME> [DIR]

协议（从 wrangler 源码逆出，官方文档没写全）：
    1. POST /accounts/{acc}/pages/projects/{proj}/upload-token        -> jwt
    2. POST /pages/assets/check-missing   {hashes:[...]}              -> 缺失的 hash（用 jwt）
    3. POST /pages/assets/upload          [{key,value(base64),...}]   -> 上传内容（用 jwt）
    4. POST /pages/assets/upsert-hashes   {hashes:[...]}              （用 jwt）
    5. POST /accounts/{acc}/pages/projects/{proj}/deployments
       multipart: manifest + branch + commit_dirty                   （用 CF_TOKEN）

关键点：**文件内容不在第 5 步上传**，第 5 步只传 manifest（路径→hash）。
"""
import os
import sys
import json
import uuid
import base64
import hashlib
import mimetypes
import urllib.request
import urllib.error

import blake3  # pip install blake3

API = 'https://api.cloudflare.com/client/v4'

SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.github', '.wrangler'}
SKIP_FILES = {'.DS_Store', 'deploy_pages.py', 'deploy_cf.sh', '_worker.js', '_worker.js.bak'}
SKIP_EXT = {'.pyc', '.swp', '.bak'}
SKIP_NAMES = {'.nojekyll'}


def collect(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES or fn.startswith('.'):
                continue
            if os.path.splitext(fn)[1] in SKIP_EXT:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            with open(full, 'rb') as f:
                content = f.read()
            ct = mimetypes.guess_type(fn)[0] or 'application/octet-stream'
            if fn.endswith('.js'):
                ct = 'application/javascript'
            elif fn.endswith('.json'):
                ct = 'application/json'
            # Cloudflare Pages 的资产哈希：blake3(base64(内容) + 扩展名).hex()[:32]
            # 注意不是 SHA-256 —— 用错算法会导致部署成功但全站 500
            ext = os.path.splitext(fn)[1][1:]
            b64 = base64.b64encode(content).decode()
            asset_hash = blake3.blake3((b64 + ext).encode()).hexdigest()[:32]
            out.append({
                'rel': rel,
                'manifestPath': '/' + rel,
                'content': content,
                'hash': asset_hash,
                'contentType': ct,
                'size': len(content),
            })
    out.sort(key=lambda x: x['rel'])
    return out


def call(path, token, data=None, method='POST', is_json=True, full_url=None):
    url = full_url or (API + path)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    if is_json and data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read().decode('utf-8', 'ignore')
            return json.loads(raw) if raw.strip() else {'success': True}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'ignore')
        try:
            j = json.loads(body)
            j['_http'] = e.code
            return j
        except Exception:
            return {'success': False, 'raw': body[:500], '_http': e.code}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    acc, project = sys.argv[1], sys.argv[2]
    root = sys.argv[3] if len(sys.argv) > 3 else '.'
    token = os.environ.get('CF_TOKEN')
    if not token:
        print('错误: 未设置 CF_TOKEN')
        sys.exit(1)

    files = collect(root)
    total = sum(f['size'] for f in files)
    print('文件 %d 个，共 %.1f KB' % (len(files), total / 1024))
    for f in files:
        print('  %-28s %7d B  %s' % (f['rel'], f['size'], f['hash'][:12]))

    # 1. upload-token
    print('\n[1/5] 获取上传凭证…')
    r = call('/accounts/%s/pages/projects/%s/upload-token' % (acc, project), token, method='GET')
    jwt = (r.get('result') or {}).get('jwt')
    if not jwt:
        print('  失败:', json.dumps(r, ensure_ascii=False)[:400])
        sys.exit(2)
    print('  jwt 已获取 (%d 字符)' % len(jwt))

    hashes = [f['hash'] for f in files]

    # 2. check-missing
    print('[2/5] 检查已存在的资源…')
    r = call('/pages/assets/check-missing', jwt,
             json.dumps({'hashes': hashes}).encode())
    missing = r.get('result')
    if not isinstance(missing, list):
        print('  返回异常:', json.dumps(r, ensure_ascii=False)[:300])
        missing = hashes
    print('  需上传 %d / %d' % (len(missing), len(files)))

    # 3. upload
    if missing:
        print('[3/5] 上传文件内容…')
        payload = [{
            'key': f['hash'],
            'value': base64.b64encode(f['content']).decode(),
            'metadata': {'contentType': f['contentType']},
            'base64': True,
        } for f in files if f['hash'] in missing]
        r = call('/pages/assets/upload', jwt, json.dumps(payload).encode())
        if not r.get('success'):
            print('  失败:', json.dumps(r, ensure_ascii=False)[:400])
            sys.exit(3)
        print('  已上传 %d 个' % len(payload))
    else:
        print('[3/5] 全部已存在，跳过')

    # 4. upsert-hashes
    print('[4/5] 更新哈希索引…')
    call('/pages/assets/upsert-hashes', jwt, json.dumps({'hashes': hashes}).encode())

    # 5. 创建部署：只传 manifest
    print('[5/5] 创建部署…')
    manifest = {f['manifestPath']: f['hash'] for f in files}

    boundary = '----KazumiWeb' + uuid.uuid4().hex
    parts = []

    def field(name, value):
        parts.append(('--' + boundary + '\r\n'
                      'Content-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                      % (name, value)).encode())

    field('manifest', json.dumps(manifest, separators=(',', ':')))
    field('branch', 'main')
    field('commit_dirty', 'true')

    # _worker.js 必须以 _worker.bundle 为字段名单独上传，不能进 manifest。
    # 而且它的内容是**一个嵌套的 multipart 表单**（Workers 标准上传格式），
    # 不是裸脚本 —— 这是 wrangler 用 `new Response(formData).blob()` 造出来的。
    worker_path = os.path.join(root, '_worker.js')
    if os.path.isfile(worker_path):
        with open(worker_path, 'rb') as wf:
            wcontent = wf.read()

        inner_b = '----KazumiInner' + uuid.uuid4().hex
        meta = json.dumps({
            'main_module': '_worker.js',
            'compatibility_date': '2026-10-08',
        }, separators=(',', ':'))

        inner = []
        inner.append(('--' + inner_b + '\r\n'
                      'Content-Disposition: form-data; name="metadata"\r\n'
                      'Content-Type: application/json\r\n\r\n' + meta + '\r\n').encode())
        inner.append(('--' + inner_b + '\r\n'
                      'Content-Disposition: form-data; name="_worker.js"; filename="_worker.js"\r\n'
                      'Content-Type: application/javascript+module\r\n\r\n').encode())
        inner.append(wcontent)
        inner.append(b'\r\n')
        inner.append(('--' + inner_b + '--\r\n').encode())
        inner_bytes = b''.join(inner)

        parts.append(('--' + boundary + '\r\n'
                      'Content-Disposition: form-data; name="_worker.bundle"; '
                      'filename="_worker.bundle"\r\n'
                      'Content-Type: application/octet-stream\r\n\r\n').encode())
        parts.append(inner_bytes)
        parts.append(b'\r\n')
        print('   附带 _worker.bundle（脚本 %d 字节，嵌套表单 %d 字节）'
              % (len(wcontent), len(inner_bytes)))

    parts.append(('--' + boundary + '--\r\n').encode())

    url = '%s/accounts/%s/pages/projects/%s/deployments' % (API, acc, project)
    req = urllib.request.Request(url, data=b''.join(parts), method='POST')
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Content-Type', 'multipart/form-data; boundary=' + boundary)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            res = json.loads(resp.read().decode('utf-8', 'ignore'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'ignore')
        print('  失败 HTTP %d' % e.code)
        print('  ', body[:400])
        sys.exit(4)

    if res.get('success'):
        r = res.get('result') or {}
        print('\n✅ 部署成功')
        print('   域名 : https://' + project + '.pages.dev')
        print('   预览 :', r.get('url'))
    else:
        print('\n❌ 部署失败')
        print(json.dumps(res, ensure_ascii=False)[:500])
        sys.exit(5)


if __name__ == '__main__':
    main()
