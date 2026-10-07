import type { WorkspaceSnapshot } from './commands.ts';
import type { Result, Token, VersionRef } from './contracts.ts';
import type { SlotSelection } from './contracts-v3.ts';
import { isV3Capable, type V3Capable } from './contracts-v4.ts';
import { assertCommand, checkToken, commandFailure } from './commands.ts';
import { ActionDomainError } from '../daily/model.ts';
import { assertDate } from '../daily/time.ts';
import { composeDailyCopy, selectCandidate } from '../drawing/model.ts';
import { activeCopy, generationFor } from './v3-operations.ts';
import { workshopCatalog } from './workshop-history.ts';

export function drawingQueries(
  read: () => Promise<WorkspaceSnapshot>,
  now: () => string,
  random: () => number,
) {
  const result = async <T>(
    token: Token,
    run: (data: V3Capable, at: string) => T,
  ): Promise<Result<T & { token: Token }>> => {
    try {
      const snapshot = await read();
      checkToken(snapshot.token, token);
      if (!isV3Capable(snapshot.data))
        throw new ActionDomainError('UNSUPPORTED_VERSION', '请先备份、预览并显式升级到 Data v3');
      return {
        ok: true,
        value: structuredClone({ ...run(snapshot.data, now()), token: snapshot.token }),
      };
    } catch (error) {
      return commandFailure(error);
    }
  };
  return {
    readWorkshop(input: { token: Token }) {
      return result(input.token, (data) => ({ catalog: workshopCatalog(data) }));
    },
    readInventory(input: { token: Token; range?: { from: string; to: string } }) {
      return result(input.token, (data) => {
        if (input.range) {
          assertDate(input.range.from);
          assertDate(input.range.to);
          if (input.range.from > input.range.to)
            throw new ActionDomainError('INVALID_INPUT', '日期范围无效');
        }
        return {
          copies: data.dailyCopies.filter(
            (copy) =>
              !input.range ||
              (copy.sourceDate >= input.range.from && copy.sourceDate <= input.range.to),
          ),
        };
      });
    },
    readArchive(input: { token: Token; sourceDate?: string; copyId?: string }) {
      return result(input.token, (data) => {
        if (input.sourceDate !== undefined) assertDate(input.sourceDate);
        return {
          logs: data.archiveLogs.filter(
            (log) =>
              (input.sourceDate === undefined || log.sourceDate === input.sourceDate) &&
              (input.copyId === undefined || log.copyId === input.copyId),
          ),
        };
      });
    },
    previewGeneration(input: {
      token: Token;
      target?: 'current' | { ruleId: string; date: string };
    }) {
      return result(input.token, (data, at) => {
        assertCommand({
          commandId: 'preview-only',
          expected: input.token,
          type: 'GenerateDailyCopies',
          payload: { target: input.target ?? 'current' },
        });
        let sequence = 0;
        const outcome = generationFor(
          data,
          input.target ?? 'current',
          at,
          () => `preview:${++sequence}`,
        );
        return {
          at,
          planned: outcome.copies.map((copy) => ({
            ruleId: copy.ruleId,
            ruleVersion: copy.ruleVersion,
            sourceDate: copy.sourceDate,
            actionCard: copy.actionCard,
          })),
          skipped: outcome.skipped,
        };
      });
    },
    previewCombo(input: { token: Token; copy: VersionRef; selections: readonly SlotSelection[] }) {
      return result(input.token, (data, at) => {
        assertCommand({
          commandId: 'preview-only',
          expected: input.token,
          type: 'AcceptDailyCopy',
          payload: { copy: input.copy, selections: input.selections, composedText: 'preview-only' },
        });
        return composeDailyCopy(
          activeCopy(data, input.copy, at),
          input.selections,
          data.bookEntries,
          data.pools,
          at,
        );
      });
    },
    selectEntry(input: {
      token: Token;
      copy: VersionRef;
      slotId: string;
      choice: { mode: 'random' } | { mode: 'manual'; entryId: string };
    }) {
      return result(input.token, (data, at) => {
        assertCommand({
          commandId: 'preview-only',
          expected: input.token,
          type: 'AcceptDailyCopy',
          payload: { copy: input.copy, selections: [], composedText: 'preview-only' },
        });
        const choice = input.choice;
        if (
          !choice ||
          (choice.mode !== 'random' && choice.mode !== 'manual') ||
          Object.keys(choice).sort().join(',') !==
            (choice.mode === 'random' ? 'mode' : 'entryId,mode')
        )
          throw new ActionDomainError('INVALID_INPUT', '请选择随机或具体词条');
        const copy = activeCopy(data, input.copy, at),
          slot = copy.slotSpecSnapshot.find((s) => s.id === input.slotId);
        if (!slot) throw new ActionDomainError('INVALID_INPUT', '槽位不存在');
        const pool = data.pools.find((p) => p.id === slot.poolId && p.poolKind === 'book');
        const candidates = data.bookEntries.filter(
          (book) => book.status === 'active' && pool?.memberIds.includes(book.id),
        );
        let book;
        if (choice.mode === 'random') book = selectCandidate(candidates, random);
        else {
          book = candidates.find((b) => b.id === choice.entryId);
          if (!book) throw new ActionDomainError('ENTRY_ARCHIVED', '书目不在可用候选中');
        }
        return {
          selection: book
            ? {
                slotId: slot.id,
                entryId: book.id,
                entrySnapshot: structuredClone(book),
                selectedAt: at,
              }
            : null,
        };
      });
    },
  };
}
