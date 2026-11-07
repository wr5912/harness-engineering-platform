import tempfile
import unittest
from pathlib import Path
from evaluation_contract import load_evaluation, cases_digest


class EvaluationContractTests(unittest.TestCase):
    def parse(self, text, **options):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'evaluation.md'
            path.write_text(text, encoding='utf-8')
            return load_evaluation(path, **options)

    text = '# 评测\n\n## 场景\n\n#### U-DOC-001 测试🙂\n\n**用户输入**\n\n> 查询\n\n**预期**\n\n完整结果。\n'

    def test_unsupported_heading_reports_location_instead_of_truncating(self):
        for heading in ['### 下载', '# 结束', '### U-DOC-002 错误用例', '#### U-DOC-002']:
            with self.assertRaisesRegex(ValueError, r'第 15 行标题层级不支持'):
                self.parse(self.text + '\n' + heading + '\n必须保留的条件。')

    def test_fenced_titles_and_labels_are_literal_and_ranges_do_not_change_digest(self):
        body = '\n```md\n### 示例\n#### U-FAKE-001 示例\n**预期**\n字面内容\n```\n#### 补充说明\n失败时保留结果。'
        result = self.parse(self.text + body, include_ranges=True)
        self.assertEqual(result['case_ids'], ['U-DOC-001'])
        self.assertEqual(result['cases']['U-DOC-001']['expected_behavior'], '完整结果。\n' + body)
        self.assertEqual(result['ranges']['U-DOC-001'], {'start_line': 4, 'end_line': 22})
        plain = self.parse(self.text + body)
        self.assertNotIn('ranges', plain)
        self.assertEqual(cases_digest(list(plain['cases'].values())), cases_digest(list(result['cases'].values())))

    def test_scene_boundary_preserves_fields(self):
        text = self.text + '\n## 第二场景\n\n#### U-DOC-002 第二条\n\n**用户输入**\n\n> 第二次查询\n\n**预期**\n\n第二结果。'
        result = self.parse(text, include_ranges=True)
        self.assertEqual(result['cases']['U-DOC-001']['expected_behavior'], '完整结果。')
        self.assertEqual(result['catalog'][1]['scene'], '第二场景')
        self.assertEqual(text.splitlines()[result['ranges']['U-DOC-001']['end_line']], '## 第二场景')


if __name__ == '__main__':
    unittest.main()
