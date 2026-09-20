import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { CcSwitchRow } from './ccswitch';

export async function readCcSwitchDb(buf: ArrayBuffer): Promise<CcSwitchRow[]> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const head = new TextDecoder().decode(buf.slice(0, 16));
  if (head !== 'SQLite format 3\0') {
    throw new Error('不是有效的 CC Switch 数据库（SQLite）文件');
  }
  const db = new SQL.Database(new Uint8Array(buf));
  try {
    const res = db.exec(
      "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type IN ('claude','codex')",
    );
    const table = res[0];
    if (!table) return [];
    return table.values.map(v => ({
      id: String(v[0]), app_type: String(v[1]), name: String(v[2]),
      settings_config: String(v[3]), is_current: Number(v[4]),
    }));
  } catch {
    throw new Error('数据库中未找到 providers 表');
  } finally {
    db.close();
  }
}
