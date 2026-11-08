import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'download_course', Path(__file__).resolve().parents[1] / 'scripts/download_course.py')
course = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(course)


class Response:
    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass


class Session:
    def __init__(self, html):
        self.html = html
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs['verify']))
        return Response(b'image bytes' if url.endswith('.png') else self.html.encode())


class ArchiveTests(unittest.TestCase):
    def test_react_sublessons_keep_number_and_unique_folder(self):
        self.assertEqual(course.lesson_number('「22-6」实现unwind流程'), 22)
        self.assertEqual(course.folder_name('「2-1」实现JSX'), '02-01 实现JSX')
        self.assertEqual(course.folder_name('「2-2」实现JSX的打包'), '02-02 实现JSX的打包')

    def test_embedded_handout_preserves_br_code_and_excludes_decoration(self):
        class Page:
            def evaluate(self, script, args):
                return {'code': 0, 'data': {'org_content': '''<section><h2>正文</h2>
                  <pre><span>装饰</span><code class="hljs">npm&nbsp;i<br>pnpm&nbsp;init<br></code></pre>
                  <img src="https://cdn.example/a.png"></section>'''}}

        item = {'id': 'test', 'title': '「1」架构', 'video_page': course.HOST,
                'handout': {'title': '「1」架构', 'url': course.HOST}}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            course.embedded_handout(Page(), Session(''), item, folder, course.REACT_COLUMN)
            text = (folder / '课件.md').read_text()
            self.assertIn('```\nnpm i\npnpm init\n```', text)
            self.assertNotIn('装饰', text)
            self.assertEqual(len(list((folder / 'images').glob('*.png'))), 1)

    def test_empty_embedded_handout_only_allowed_for_course_intro(self):
        class Page:
            def evaluate(self, script, args):
                return {'code': 0, 'data': {'org_content': ''}}

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            item = {'id': 'test', 'title': '「1」架构', 'video_page': course.HOST}
            with self.assertRaisesRegex(RuntimeError, '正文为空'):
                course.embedded_handout(Page(), Session(''), item, folder, course.REACT_COLUMN)
            item['title'] = '课程介绍'
            course.embedded_handout(Page(), Session(''), item, folder, course.REACT_COLUMN)
            self.assertIn('没有课件正文', (folder / '课件.md').read_text())

    def test_video_capture_waits_for_permission_and_manifest(self):
        class VideoResponse:
            ok = True

            def __init__(self, url):
                self.url = url

            def json(self):
                return {'code': 0, 'data': {'is_available': 1, 'product_try_info': {},
                                           'video_info': {'video_length': 991}}}

        class Page:
            def on(self, event, callback):
                self.callback = callback

            def goto(self, *args, **kwargs):
                self.callback(VideoResponse(course.HOST +
                    '/xe.course.business_go.video.detail_info.get/2.0.0'))
                self.callback(VideoResponse('https://cdn.example/main.m3u8?sign=test'))

            def evaluate(self, code):
                pass

            def remove_listener(self, *args):
                self.removed = True

        page = Page()
        self.assertEqual(course.capture_video(page, {'video_page': course.HOST}),
                         ('https://cdn.example/main.m3u8?sign=test', 991))
        self.assertTrue(page.removed)

    def test_split_lessons_keep_distinct_folders_and_shared_number(self):
        titles = ['43. 实战三 Compoder Cli 1', '43. 实战三 Compoder Cli 2']
        self.assertEqual([course.lesson_number(t) for t in titles], [43, 43])
        self.assertNotEqual(*[course.folder_name(t) for t in titles])
        self.assertEqual(course.folder_name('1. A/B?'), '01 A_B_')

    def test_markdown_preserves_code_and_downloads_local_images(self):
        session = Session('''<nav>导航</nav><main><div class="vp-doc">
          <h2>正文<a class="header-anchor" href="#body">锚点</a></h2>
          <div class="language-js"><button>复制</button><pre><code><span>const a = 1;</span>
console.log(a);</code></pre></div>
          <img src="/images/a.png"><a href="/docs/b.html">另一课</a>
        </div></main>''')
        doc = {'title': '测试课', 'url': course.DOCS + 'docs/a.html'}
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            course.archive_handout(session, doc, folder, True)
            text = (folder / '课件.md').read_text()
            self.assertIn('```js\nconst a = 1;\nconsole.log(a);\n```', text)
            self.assertNotIn('复制', text)
            self.assertNotIn('导航', text)
            self.assertNotIn('锚点', text)
            self.assertIn('https://doc.iamkasong.com/docs/b.html', text)
            self.assertIn('images/', text)
            self.assertEqual(len(list((folder / 'images').glob('*.png'))), 1)
            count = len(session.calls)
            self.assertEqual(course.archive_handout(session, doc, folder, True), '已存在')
            self.assertEqual(len(session.calls), count)

    def test_certificate_exception_only_applies_to_docs_host(self):
        session = Session('body')
        course.get_doc(session, course.DOCS, True)
        course.get_doc(session, course.HOST, True)
        self.assertEqual([verify for _, verify in session.calls], [False, True])


if __name__ == '__main__':
    unittest.main()
