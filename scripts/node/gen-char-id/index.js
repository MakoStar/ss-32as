const path = require('path');
const { LuaFactory } = require('wasmoon');
const { writeFileSync, mkdirSync } = require('fs');


const REGION_CODES = ['CN', 'EN', 'JP', 'KR', 'TW'];
const CHARACTER_ID_PATTERN = /^avg1_(\d{3})$/;
const OUTPUT_FILENAME = 'characterid.json';
const OUTPUT_DIR = path.join(process.cwd(), 'generated_data');
mkdirSync(OUTPUT_DIR, { recursive: true });
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILENAME);
const REPO_BASE = 'https://github.com/MakoStar/ss-lua/raw/refs/heads/main/';


function buildLuaFileUrls(regionCode) {
  const regionBase = new URL(`./Lua/Game/UI/Avg/_${regionCode.toLowerCase()}/`, REPO_BASE);
  return {
    avgCharacterUrl: new URL('./Preset/AvgCharacter.lua', regionBase),
    avgContactUrl: new URL('./Preset/AvgContacts.lua', regionBase),
  };
}


async function fetchLuaText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`[fetch] ${response.status} | ${response.statusText} | ${url.href}`);
    return null;
  }
  return response.text();
}


async function evaluateLua(lua, source) {
  try {
    return await lua.doString(source);
  } catch (error) {
    console.error(`[lua] parse error: ${error.message}`);
    return null;
  }
}


function resolveDisplayName(rawName, characterId, contactsById, regionCharactersById, reuseId) {
  if (rawName !== '***') return rawName;
  const contact = contactsById.get(characterId);
  if (contact?.name) return contact.name;
  const reusedCharacter = regionCharactersById.get(String(reuseId));
  return reusedCharacter?.name ?? '';
}


function mergeRegionCharacters(charactersById, versionsByCharId, regionKey, regionCharacters, regionContacts) {
  const contactsById = new Map(regionContacts.map((c) => [String(c.id), c]));
  const regionCharactersById = new Map(regionCharacters.map((c) => [String(c.id), c]));
  const unmatchedEntries = { ...charactersById };

  for (const { id: rawId, name: rawName, ver: rawVersion, reuse: reuseId } of regionCharacters) {
    if (typeof rawId !== 'string') continue;

    const idMatch = rawId.match(CHARACTER_ID_PATTERN);
    if (!idMatch) continue;

    const characterId = idMatch[1];
    const contact = contactsById.get(characterId);
    delete unmatchedEntries[characterId];

    const displayName = resolveDisplayName(
      rawName,
      characterId,
      contactsById,
      regionCharactersById,
      reuseId
    );

    const resolvedVersion = (rawVersion ?? contact?.ver) || '';

    if (!charactersById[characterId]) {
      charactersById[characterId] = { id: Number(characterId) };
      versionsByCharId[characterId] = new Set();
    }

    const entry = charactersById[characterId];
    entry[`${regionKey}Name`] = displayName || '';

    if (!entry.findKeys) entry.findKeys = new Set();
    if (rawId) entry.findKeys.add(rawId);
    if (reuseId) entry.findKeys.add(reuseId);

    if (resolvedVersion) {
      versionsByCharId[characterId].add(resolvedVersion);
    }
  }

  if (Object.keys(unmatchedEntries).length) {
    console.log(`[${regionKey.toUpperCase()}] unmatched`, unmatchedEntries);
    for (const [characterId, { findKeys }] of Object.entries(unmatchedEntries)) {
      for (const lookupId of findKeys) {
        const contact = contactsById.get(lookupId);
        if (contact?.name) {
          charactersById[characterId][`${regionKey}Name`] = contact.name;
          break;
        }
        const reusedCharacter = regionCharactersById.get(String(lookupId));
        if (reusedCharacter?.name) {
          charactersById[characterId][`${regionKey}Name`] =
            reusedCharacter.name;
          break;
        }
      }
    }
  }
}


function applyVersions(charactersById, versionsByCharId) {
  for (const [characterId, versionSet] of Object.entries(versionsByCharId)) {
    const sortedVersions = [...versionSet]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    charactersById[characterId].ver =
      sortedVersions.length <= 1
        ? sortedVersions[0] ?? ''
        : sortedVersions.join(' / ');
  }
}


function fillMissingRegionNames(charactersById) {
  const regionNameKeys = REGION_CODES.map((code) => `${code.toLowerCase()}Name`);
  for (const entry of Object.values(charactersById)) {
    for (const key of regionNameKeys) entry[key] ??= '';
  }
}


(async () => {
  if (!process.env.CI) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const charactersById = {};
  const versionsByCharId = {};

  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  try {
    for (const regionCode of REGION_CODES) {
      console.log('='.repeat(60));
      const regionKey = regionCode.toLowerCase();
      const { avgCharacterUrl, avgContactUrl } = buildLuaFileUrls(regionCode);

      console.log(`[${regionCode}] fetch lua start`);
      const [characterSource, contactSource] = await Promise.all([
        fetchLuaText(avgCharacterUrl),
        fetchLuaText(avgContactUrl),
      ]);

      if (!characterSource || !contactSource) {
        console.warn(`[${regionCode}] fetch lua failed. skipping`);
        continue;
      }

      const regionCharacters = await evaluateLua(lua, characterSource);
      const regionContacts = await evaluateLua(lua, contactSource);

      if (!Array.isArray(regionCharacters) || !Array.isArray(regionContacts)) {
        console.warn(`[${regionCode}] data is not array, skipping`);
        continue;
      }

      mergeRegionCharacters(
        charactersById,
        versionsByCharId,
        regionKey,
        regionCharacters,
        regionContacts
      );

      console.log(
        `[${regionCode}] generated characters ${Object.keys(charactersById).length}`
      );
    }

    applyVersions(charactersById, versionsByCharId);
    fillMissingRegionNames(charactersById);

    writeFileSync(OUTPUT_PATH, 
      JSON.stringify(
        charactersById, 
        (key, value) => (key === 'findKeys' ? undefined : value), 
        2,
      ),
      { encoding: 'utf-8' }
    );

    console.log('='.repeat(60));
    console.log(`[done] total ${Object.keys(charactersById).length} written to ${OUTPUT_PATH}`);
  } finally {
    lua.global.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
