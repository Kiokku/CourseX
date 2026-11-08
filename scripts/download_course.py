#!/usr/bin/env python3
"""下载小鹅通课程视频及对应 Markdown 课件。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / '.coursex'
STATE = PRIVATE / 'auth.json'
HOST = 'https://appjiz2zqrn2142.h5.xiaoeknow.com'
COLUMN = 'p_673d5557e4b023c058a79b7d'
COURSE = f'{HOST}/p/course/column/{COLUMN}?type=3&channel_id='
DOCS = 'https://doc.iamkasong.com/'
ITEMS_API = '/xe.course.business_go.column.items.get/2.0.0'
REACT_COLUMN = 'p_638035c1e4b07b05581d25db'


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def lesson_number(title):
    match = re.match(r'^\s*(?:「)?(\d+)(?:-\d+)?\s*[.．、」]', title)
    return int(match[1]) if match else None


def folder_name(title):
    number = lesson_number(title)
    bracket = re.match(r'^\s*「(\d+)(?:-(\d+))?」\s*', title)
    if bracket:
        prefix = f'{int(bracket[1]):02d}'
        if bracket[2]:
            prefix += f'-{int(bracket[2]):02d}'
        title = prefix + ' ' + title[bracket.end():]
    elif number is not None:
        title = f'{number:02d} ' + re.sub(r'^\s*\d+\s*[.．、]\s*', '', title)
    else:
        title = '00 ' + title
    return re.sub(r'[\x00-\x1f/\\:*?"<>|]', '_', title).strip().rstrip('.')


def get_doc(session, url, insecure):
    # The exception is restricted to this exact handout host, never the login site.
    verify = not (insecure and urlparse(url).hostname == 'doc.iamkasong.com')
    response = session.get(url, timeout=(15, 60), verify=verify)
    response.raise_for_status()
    return response


def docs_index(session, insecure):
    soup = BeautifulSoup(get_doc(session, DOCS, insecure).content, 'html.parser')
    first = soup.select_one('a.VPButton[href^="/docs/"]')
    if not first:
        raise RuntimeError('课件首页未找到课程文档入口')
    soup = BeautifulSoup(get_doc(session, urljoin(DOCS, first['href']), insecure).content,
                         'html.parser')
    result = {}
    for anchor in soup.select('.VPSidebar a[href]'):
        title = anchor.get_text(' ', strip=True)
        number = lesson_number(title)
        if number is not None:
            if number in result:
                raise RuntimeError(f'课件目录出现重复课号：{number}')
            result[number] = {'title': title, 'url': urljoin(DOCS, anchor['href'])}
    if not result:
        raise RuntimeError('课件侧栏没有带课号的链接，站点结构可能已变化')
    return result


def archive_handout(session, doc, folder, insecure):
    destination = folder / '课件.md'
    if destination.exists() and destination.stat().st_size:
        return '已存在'
    soup = BeautifulSoup(get_doc(session, doc['url'], insecure).content, 'html.parser')
    content = soup.select_one('main .vp-doc')
    if not content:
        raise RuntimeError('未找到 VitePress 正文 main .vp-doc')
    return write_handout(session, doc, folder, content, insecure)


def write_handout(session, doc, folder, content, insecure=False):
    destination = folder / '课件.md'
    for element in content.select('.header-anchor, button, script, style'):
        element.decompose()
    for pre in content.select('pre'):
        code = pre.find('code')
        if code:
            classes = code.get('class', []) + pre.parent.get('class', [])
            pre['class'] = [c for c in classes if c.startswith('language-')]
            # 小鹅通的 mdnice 正文使用 br 和不换行空格排版代码。
            for br in code.select('br'):
                br.replace_with('\n')
            code_text = code.get_text().replace('\xa0', ' ')
            pre.clear()
            pre.append(code_text)
    for image in content.select('img[src]'):
        source = urljoin(doc['url'], image['src'])
        if source.startswith('data:'):
            continue
        suffix = Path(unquote(urlparse(source).path)).suffix or '.png'
        relative = Path('images') / (hashlib.sha256(source.encode()).hexdigest()[:16] + suffix)
        target = folder / relative
        target.parent.mkdir(exist_ok=True)
        if not target.exists():
            response = get_doc(session, source, insecure)
            temporary = target.with_suffix(target.suffix + '.part')
            temporary.write_bytes(response.content)
            temporary.replace(target)
        image['src'] = relative.as_posix()
    for anchor in content.select('a[href]'):
        if not anchor['href'].startswith('#'):
            anchor['href'] = urljoin(doc['url'], anchor['href'])
    body = markdownify(str(content), heading_style='ATX', bullets='-',
                       code_language_callback=lambda el: next(
                           (c.removeprefix('language-') for c in el.get('class', [])
                            if c.startswith('language-')), ''))
    text = f"# {doc['title']}\n\n来源：{doc['url']}\n\n" + body.strip() + '\n'
    temporary = destination.with_suffix('.md.part')
    temporary.write_text(text, encoding='utf-8')
    temporary.replace(destination)
    return '已下载'


def course_items(page, column=COLUMN):
    rows, page_index, total = [], 1, None
    while total is None or len(rows) < total:
        data = page.evaluate('''async ({endpoint, column, pageIndex}) => {
            const response = await fetch(endpoint, {
                method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: new URLSearchParams({'bizData[column_id]': column,
                    'bizData[page_index]': pageIndex, 'bizData[page_size]': 8,
                    'bizData[sort]': 'desc'})});
            return await response.json();
        }''', {'endpoint': ITEMS_API, 'column': column, 'pageIndex': page_index})
        if data.get('code') != 0 or not isinstance(data.get('data'), dict):
            raise RuntimeError(f"目录接口失败：code={data.get('code')}，请重新登录")
        batch = data['data']['list']
        total = int(data['data']['total'])
        if not batch and len(rows) < total:
            raise RuntimeError('目录分页提前结束')
        rows.extend(batch)
        page_index += 1
    if len({row['resource_id'] for row in rows}) != len(rows):
        raise RuntimeError('目录分页出现重复资源，停止以免漏课')
    return rows


def embedded_handout(page, session, item, folder, column):
    destination = folder / '课件.md'
    if destination.exists() and destination.stat().st_size:
        return '已存在'
    result = page.evaluate('''async ({id, column}) => {
        const response = await fetch('/xe.course.business_go.get.detail/2.0.0', {
            method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams({'bizData[resource_id]': id,
                                      'bizData[product_id]': column})});
        return await response.json();
    }''', {'id': item['id'], 'column': column})
    if result.get('code') != 0 or not isinstance(result.get('data'), dict):
        raise RuntimeError(f"页内课件接口失败：code={result.get('code')}，请检查登录")
    data = result['data']
    if data.get('auto_fetch') or data.get('content_url'):
        raise RuntimeError('课件使用外部正文，需重新检查页面结构')
    content = BeautifulSoup(data.get('org_content') or '', 'html.parser')
    if not content.get_text(strip=True) and not content.select('img'):
        if item['title'] != '课程介绍':
            raise RuntimeError('课件正文为空，请检查权限或页面')
        destination.write_text(f"# {item['title']}\n\n来源：{item['video_page']}\n\n"
                               '该视频页面没有课件正文。\n', encoding='utf-8')
        return '无课件正文（已记录）'
    return write_handout(session, item['handout'], folder, content)


def capture_video(page, item):
    captured = {}

    def on_response(response):
        if urlparse(response.url).path.endswith('.m3u8') and response.ok:
            captured.setdefault('url', response.url)
        if '.video.detail_info.get/' in response.url and response.ok:
            captured['detail'] = response.json()

    page.on('response', on_response)
    try:
        page.goto(item['video_page'], wait_until='domcontentloaded', timeout=60000)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            detail = captured.get('detail', {})
            if detail.get('code', 0) != 0:
                raise RuntimeError(f"播放接口失败：code={detail.get('code')}")
            if detail and detail['data'].get('is_available') != 1:
                raise RuntimeError('当前账号没有该视频的完整播放权限，请重新登录已购课账号')
            if captured.get('url') and detail:
                break
            page.wait_for_timeout(250)
        else:
            raise RuntimeError('60 秒内没有捕获播放地址，请检查登录或在浏览器中确认可播放')
        page.evaluate('document.querySelectorAll("video").forEach(v => v.pause())')
        info = captured['detail']['data']
        # Avoid archiving a preview in place of the complete paid lesson.
        if info.get('product_try_info'):
            raise RuntimeError('只有试看权限')
        return captured['url'], info.get('video_info', {}).get('video_length')
    finally:
        page.remove_listener('response', on_response)


def download_video(page, item, folder):
    destination = folder / '视频.mp4'
    if destination.exists() and destination.stat().st_size:
        return '已存在'
    url, expected_duration = capture_video(page, item)
    ua = page.evaluate('navigator.userAgent')
    # FFmpeg reads the signed HLS manifest, standard AES-128 key URI and segments.
    # It does not construct tokens or alter the site's authorization responses.
    temporary = folder / '视频.part.mp4'
    log = PRIVATE / f"{item['id']}.ffmpeg.log"
    command = ['ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'warning',
               '-rw_timeout', '60000000', '-user_agent', ua,
               '-headers', f"Referer: {item['video_page']}\r\n", '-i', url,
               '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
               '-movflags', '+faststart', str(temporary)]
    with log.open('w') as output:
        result = subprocess.run(command, stdout=output, stderr=output)
    if result.returncode != 0:
        raise RuntimeError(f'FFmpeg 失败，私有日志：.coursex/{log.name}')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                            'format=duration:stream=codec_type', '-of', 'json', str(temporary)],
                           capture_output=True, text=True, check=True)
    metadata = json.loads(probe.stdout)
    duration = float(metadata['format']['duration'])
    if not any(s.get('codec_type') == 'video' for s in metadata['streams']):
        raise RuntimeError('下载结果没有视频流')
    if expected_duration and duration < float(expected_duration) - 5:
        raise RuntimeError(f'视频不完整：{duration:.1f}s / {expected_duration}s')
    temporary.replace(destination)
    return '已下载'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--course', choices=('ai', 'react18'), default='ai', help='选择课程')
    parser.add_argument('--login', action='store_true', help='打开浏览器手动登录并保存状态')
    parser.add_argument('--plan', action='store_true', help='只生成完整课程/课件匹配清单')
    parser.add_argument('--docs-only', action='store_true', help='只下载 Markdown 与图片')
    parser.add_argument('--lessons', help='只处理指定课号，如 1,6,43；43 会包含两段')
    parser.add_argument('--limit', type=int, help='只处理前 N 个视频，供试跑')
    parser.add_argument('--headed', action='store_true', help='显示下载用浏览器')
    parser.add_argument('--insecure-docs', action='store_true', help='兼容课件站过期证书')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error('--limit 必须为正数')
    selected = {int(n) for n in args.lessons.split(',')} if args.lessons else None
    if not (args.login or args.plan or args.docs_only):
        for tool in ('ffmpeg', 'ffprobe'):
            if not shutil.which(tool):
                parser.error(f'缺少 {tool}，macOS 可运行 brew install ffmpeg')
    os.umask(0o077)
    PRIVATE.mkdir(exist_ok=True)
    PRIVATE.chmod(0o700)
    embedded = args.course == 'react18'
    column = REACT_COLUMN if embedded else COLUMN
    course_url = f'{HOST}/p/course/column/{column}?product_id={column}' if embedded else COURSE
    library_root = Path(os.environ.get('COURSEX_LIBRARY') or ROOT / 'library')
    default_output = library_root / ('从0实现 React 18' if embedded else '前端+AI转型探索营')
    output = (args.output or default_output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not (args.login or args.headed or not STATE.exists()))
        context = browser.new_context(storage_state=str(STATE) if STATE.exists() else None)
        page = context.new_page()
        page.goto(course_url, wait_until='domcontentloaded', timeout=60000)
        if args.login or not STATE.exists():
            print('请在浏览器登录已购课账号，回到终端按回车。', flush=True)
            input()
            page.goto(course_url, wait_until='domcontentloaded', timeout=60000)
            context.storage_state(path=str(STATE))
            STATE.chmod(0o600)
            if args.login:
                print('登录状态已保存到 .coursex/auth.json')
                browser.close()
                return 0
        page.wait_for_function("!document.title.startsWith('Loading')", timeout=60000)
        rows = course_items(page, column)
        session = requests.Session()
        session.headers['User-Agent'] = page.evaluate('navigator.userAgent')
        if args.insecure_docs:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            print('课件站启用过期证书兼容；课程登录和视频仍校验证书。')
        docs = {} if embedded else docs_index(session, args.insecure_docs)
        videos = []
        for row in rows:
            if row['resource_type'] != 3:
                continue
            title = row['resource_title'].strip()
            number = lesson_number(title)
            video_page = urljoin(HOST, row['jump_url'])
            videos.append({'id': row['resource_id'], 'title': title, 'number': number,
                           'folder': folder_name(title),
                           'video_page': video_page,
                           'handout': {'title': title, 'url': video_page} if embedded else docs.get(number)})
        if len({v['folder'] for v in videos}) != len(videos):
            raise RuntimeError('文件夹名称重复，请检查目录')
        save_json(output / '课程清单.json', {'course': course_url,
                                            'docs': '视频页面内课件' if embedded else DOCS, 'videos': videos,
                                            'non_video': [r['resource_title'] for r in rows
                                                          if r['resource_type'] != 3]})
        print(f'目录：{len(rows)} 条内容，{len(videos)} 个视频，' +
              ('课件取自各视频页面。' if embedded else f'{len(docs)} 篇课件。'), flush=True)
        if selected:
            missing = selected - {v['number'] for v in videos}
            if missing:
                raise RuntimeError(f'目录中没有这些课号：{sorted(missing)}')
            videos = [v for v in videos if v['number'] in selected]
        if args.limit:
            videos = videos[:args.limit]
        if args.plan:
            for item in videos:
                print(item['folder'], '→', item['handout']['title'] if item['handout'] else '无对应课件')
            browser.close()
            return 0
        report_path = output / '下载结果.json'
        report = json.loads(report_path.read_text()) if report_path.exists() else {}
        failures = 0
        for index, item in enumerate(videos, 1):
            print(f"[{index}/{len(videos)}] {item['title']}", flush=True)
            folder = output / item['folder']
            folder.mkdir(exist_ok=True)
            (folder / '来源.md').write_text(
                f"# {item['title']}\n\n视频页面：{item['video_page']}\n\n" +
                (f"课件页面：{item['handout']['url']}\n" if item['handout'] else
                 '课件站没有该视频对应的独立课件。\n'), encoding='utf-8')
            status = report.setdefault(item['id'], {'title': item['title']})
            actions = [('handout', lambda: embedded_handout(page, session, item, folder, column)
                        if embedded else archive_handout(session, item['handout'], folder,
                                                         args.insecure_docs))] if item['handout'] else []
            if not item['handout']:
                status['handout'] = '无对应课件'
            if not args.docs_only:
                actions.append(('video', lambda: download_video(page, item, folder)))
            for component, action in actions:
                try:
                    status[component] = action()
                except Exception as error:
                    failures += 1
                    # Network exceptions can include signed URLs; do not persist those publicly.
                    message = re.sub(r'https?://\S+', '[URL]', str(error))
                    status[component] = '失败：' + message
                print(f'  {component}: {status[component]}', flush=True)
                save_json(report_path, report)
        context.storage_state(path=str(STATE))
        browser.close()
        print(f'本次失败 {failures} 项；结果：{report_path}')
        return 1 if failures else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n已中断；完成文件保留，下次运行跳过。', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print('错误：' + re.sub(r'https?://\S+', '[URL]', str(error)), file=sys.stderr)
        sys.exit(1)
