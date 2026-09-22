const path = require('path');
const { LuaFactory } = require('wasmoon');
const { writeFileSync, mkdirSync } = require('fs');

/** 各地区数据源标识 */
const REGIONS = ['CN', 'EN', 'JP', 'KR', 'TW'];

/** 角色 id 匹配规则 只取 avg1 前缀的三位数字 */
const CHAR_ID_PATTERN = /^avg1_(\d{3})$/;

/** 导出的 json 文件名 */
const OUTPUT_FILE = 'characterid.json';
const outputDir = path.join(process.cwd(), 'generated_data');
mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'characterid.json');

/**
 * 构造某个地区的两个 lua 数据文件地址
 * @param {string} region 地区标识 如 CN EN
 * @returns {[URL, URL]} 角色表地址 联系人表地址
 */
function buildConfigUrls(region) {
  const repoBase = 'https://github.com/MakoStar/ss-lua/raw/refs/heads/main/';
  const regionBase = new URL(`./Lua/Game/UI/Avg/_${region.toLowerCase()}/`, repoBase);
  const characterUrl = new URL('./Preset/AvgCharacter.lua', regionBase);
  const contactUrl = new URL('./Preset/AvgContacts.lua', regionBase);
  return [characterUrl, contactUrl];
}

/**
 * 下载文本 失败返回 null
 * @param {URL} url
 * @returns {Promise<string|null>}
 */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[fetch] ${res.status} ${res.statusText} ${url.href}`);
    return null;
  }
  return res.text();
}

/**
 * 解析 lua 文本 失败返回 null
 * @param {object} lua 已经创建好的 lua 引擎
 * @param {string} code lua 源码
 * @returns {Promise<any|null>}
 */
async function parseLua(lua, code) {
  try {
    return await lua.doString(code);
  } catch (e) {
    console.error(`[lua] parse error ${e.message}`);
    return null;
  }
}

/**
 * 从联系人表里取角色名
 * @param {string} fallbackName 角色表里原本的名字
 * @param {string} charId 三位数字 id
 * @param {Map} contactMap 联系人 id 到联系人的映射
 * @param {Map} charMap 角色 id 到角色的映射
 * @param {string|number} reuseId 复用的角色 id
 * @returns {string}
 */
function resolveCharacterName(fallbackName, charId, contactMap, charMap, reuseId) {
  if (fallbackName !== '***') return fallbackName;
  const contact = contactMap.get(charId);
  if (contact?.name) return contact.name;
  const reused = charMap.get(reuseId);
  return reused?.name ?? '';
}

/**
 * 收集某个地区的角色数据到总表
 * @param {object} store 总表
 * @param {object} versionSets 每个角色的版本集合
 * @param {string} regionKey 地区小写标识
 * @param {Array} characterList 角色表
 * @param {Array} contactList 联系人表
 */
function collectCharacters(store, versionSets, regionKey, characterList, contactList) {
  const contactMap = new Map(contactList.map((c) => [c.id, c]));
  const charMap = new Map(characterList.map((c) => [c.id, c]));

  for (const { id, name, ver, reuse } of characterList) {
    if (typeof id !== 'string') continue;

    const matched = id.match(CHAR_ID_PATTERN);
    if (!matched) continue;

    const charId = matched[1];
    const contact = contactMap.get(charId);

    const charName = resolveCharacterName(name, charId, contactMap, charMap, reuse);
    const charVer = (ver ?? contact?.ver) || '';

    if (!store[charId]) {
      store[charId] = { id: charId };
      versionSets[charId] = new Set();
    }

    store[charId][`${regionKey}Name`] = charName || '';

    if (charVer) versionSets[charId].add(charVer);
  }
}

/**
 * 把版本集合写回总表 相同去重 不同拼接
 * @param {object} store 总表
 * @param {object} versionSets 每个角色的版本集合
 */
function applyVersions(store, versionSets) {
  for (const [charId, set] of Object.entries(versionSets)) {
    const list = [...set]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    store[charId].ver = list.length <= 1 ? list[0] ?? '' : list.join(' / ');
  }
}

/**
 * 补齐所有地区名字字段 保证结构一致
 * @param {object} store 总表
 */
function fillMissingNames(store) {
  const regionKeys = REGIONS.map((r) => r.toLowerCase());
  for (const entry of Object.values(store)) {
    for (const key of regionKeys) {
      entry[`${key}Name`] ??= '';
    }
  }
}

(async () => {
  const characters = {};
  const versionSets = {};

  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  try {
    for (const region of REGIONS) {
      const regionKey = region.toLowerCase();
      const [characterUrl, contactUrl] = buildConfigUrls(region);

      console.log(`[fetch] ${region} start`);

      const [characterCode, contactCode] = await Promise.all([
        fetchText(characterUrl),
        fetchText(contactUrl),
      ]);

      if (!characterCode || !contactCode) {
        console.warn(`[skip] ${region} fetch failed`);
        continue;
      }

      const characterList = await parseLua(lua, characterCode);
      const contactList = await parseLua(lua, contactCode);

      if (!Array.isArray(characterList) || !Array.isArray(contactList)) {
        console.warn(`[skip] ${region} data is not array`);
        continue;
      }

      collectCharacters(characters, versionSets, regionKey, characterList, contactList);

      console.log(`[ok] ${region} characters ${Object.keys(characters).length}`);
    }

    applyVersions(characters, versionSets);
    fillMissingNames(characters);

    writeFileSync(outputPath, JSON.stringify(characters, null, 2));

    console.log(`[done] total ${Object.keys(characters).length} written to ${outputPath}`);
  } finally {
    lua.global.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
