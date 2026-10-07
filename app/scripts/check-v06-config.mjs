import fs from 'node:fs/promises';
import { readConfiguration } from '../src/workspace/v5-config.ts';
import {
  configurationExample,
  CONFIGURATION_AI_PROMPT,
} from '../src/workspace/v5-config-example.ts';
import { MAX_INPUT_BYTES } from '../src/workspace/format.ts';
if (process.argv[2] === '--example') console.log(JSON.stringify(configurationExample(), null, 2));
else if (process.argv[2] === '--prompt') console.log(CONFIGURATION_AI_PROMPT);
else {
  try {
    const file = process.argv[2];
    if (!file)
      throw Error('用法：node scripts/check-v06-config.mjs 配置.json | --example | --prompt');
    const stat = await fs.stat(file);
    if (stat.size > MAX_INPUT_BYTES) throw Error('输入超过 64 MiB');
    const result = readConfiguration(await fs.readFile(file, 'utf8'));
    console.log(
      '配置格式、引用和牌堆容量校验通过；导入仍需 Host 预览。' +
        (result.legacyMapping ? '旧 ConfigV3 将在预览中映射字段与决策。' : ''),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
