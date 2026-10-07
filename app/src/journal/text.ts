import type { Token } from '../workspace/index.ts';
import { fingerprint } from '../workspace/codec.ts';
import { compareInstants, displayInstant } from '../daily/time.ts';
import { V06ContractError } from '../workspace/v06.ts';
import { prepareTextDocument } from '../text-output/model.ts';
import type { JournalProjection } from './timeline.ts';

const lf = (text: string) => text.replace(/\r\n|\r/g, '\n');
const inline = (text: string) => JSON.stringify(text);
const stamp = (at: string, zone: string) => {
  const local = displayInstant(at, zone);
  return `${local.date} ${local.time} ${local.offset} [${zone}]（UTC ${at}）`;
};
export function renderJournalText(projection: JournalProjection): string {
  const { timeline, rows, plannedComparisons } = projection;
  const lines = [
    `# CardGrid 日记 ${timeline.date}`,
    `查看时区：${timeline.zone}`,
    '',
    '## 时间线',
    '',
  ];
  if (!rows.length) lines.push('当天无自动安排、参考或感想。', '');
  for (const row of rows) {
    if (row.kind === 'automatic') {
      const segment = row.segment;
      lines.push(
        `### ${segment.status === 'confirmed' ? '已确认事实' : segment.status === 'planned' ? '计划' : '固定安排'} · ${inline(segment.title)}`,
        `显示：${segment.clippedRange.localStart} ${segment.clippedRange.startOffset} — ${segment.clippedRange.localEnd} ${segment.clippedRange.endOffset} [${segment.clippedRange.zone}]`,
        `原范围：${stamp(segment.range.startAt, segment.range.zone)} — ${stamp(segment.range.endAt, segment.range.zone)}`,
        `来源：${segment.sourceKey}`,
      );
      for (const answer of segment.referenceAnswers)
        lines.push(`参考：${inline(answer.question)} → ${inline(answer.entry.title)}`);
    } else if (row.kind === 'reference')
      lines.push(
        `### 独立参考（时间点，占用 0 分钟）`,
        `位置：${stamp(row.point.at, row.point.zone)}`,
        `${inline(row.answer.question)} → ${inline(row.answer.entry.title)}`,
      );
    else {
      const note = row.note;
      lines.push(
        `### 感想 ${inline(note.id)}`,
        `归属日：${note.date} [${note.zone}]`,
        `原记录：${stamp(note.recordedAt, note.zone)}`,
      );
      if (note.date < displayInstant(note.recordedAt, note.zone).date)
        lines.push(`补记于：${stamp(note.recordedAt, note.zone)}`);
      if (compareInstants(note.updatedAt, note.recordedAt) !== 0)
        lines.push(`修改于：${stamp(note.updatedAt, note.zone)}`);
      lines.push(note.text ? lf(note.text) : '（已清空，保留条目及原时间）');
    }
    lines.push('');
  }
  if (plannedComparisons.length) {
    lines.push('## 原计划对照（不另计生活行为）', '');
    for (const comparison of plannedComparisons)
      lines.push(
        `${comparison.sourceKey}：${stamp(comparison.range.startAt, comparison.range.zone)} — ${stamp(comparison.range.endAt, comparison.range.zone)}；实际 ${stamp(comparison.actualRange.startAt, comparison.actualRange.zone)} — ${stamp(comparison.actualRange.endAt, comparison.actualRange.zone)}`,
        '',
      );
  }
  lines.push('## 历史正文', '');
  if (!timeline.legacyBlocks.length) lines.push('无旧正文。', '');
  for (const block of timeline.legacyBlocks)
    lines.push(
      `### 旧正文 ${inline(block.id)} · ${block.date} [${block.zone}]`,
      `原篇创建：${stamp(block.createdAt, block.zone)}`,
      `原篇修改：${stamp(block.updatedAt, block.zone)}`,
      block.text ? lf(block.text) : '（正文已清空，保留原篇）',
      '',
    );
  return lines.join('\n');
}
export async function prepareJournalText(
  projection: JournalProjection,
  token: Token = projection.token,
) {
  if (token.epoch !== projection.token.epoch || token.revision !== projection.token.revision)
    throw new V06ContractError('PREVIEW_STALE', 'token', '旧表盘投影不能标记为新的工作区版本');
  const { token: _, ...renderInput } = projection;
  return prepareTextDocument(renderJournalText(projection), {
    kind: 'journal',
    token: structuredClone(projection.token),
    inputFingerprint: await fingerprint(renderInput),
  });
}
