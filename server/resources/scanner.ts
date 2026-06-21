/**
 * Resource Scanner — 扫描本地 Claude Code 已安装资源和 Marketplace 插件
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DiscoveredResource {
  name: string;
  type: 'skill' | 'agent' | 'mcp';
  description: string;
  version: string;
  source: 'claude-code' | 'marketplace' | 'git' | 'import';
  sourcePath: string;
  config: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const MARKETPLACE_DIR = path.join(CLAUDE_DIR, 'plugins', 'marketplaces', 'claude-plugins-official');

/** Scan Claude Code ~/.claude/skills/ for installed skills */
export function scanLocalSkills(): DiscoveredResource[] {
  const results: DiscoveredResource[] = [];

  if (!fs.existsSync(SKILLS_DIR)) return results;

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(SKILLS_DIR, entry.name);

    // Read SKILL.md for prompt/description
    const skillMdPath = path.join(dirPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    let description = '';
    let prompt = '';
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      // Parse YAML frontmatter if present (--- ... ---)
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
        // Skill name from frontmatter
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        if (nameMatch && nameMatch[1].trim() !== entry.name) {
          // name field in frontmatter takes precedence
        }
      }
      // Body is the prompt
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      prompt = body;
      if (!description) {
        description = body.split('\n')[0]?.replace(/^#+\s*/, '').trim() || entry.name;
      }
    } catch {
      continue;
    }

    // Read _meta.json for version info
    let version = '1.0.0';
    let metadata: Record<string, unknown> = {};
    const metaPath = path.join(dirPath, '_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (metadata.version) version = metadata.version as string;
      } catch { /* ignore */ }
    }

    // Read skill-card.md for richer description
    const cardPath = path.join(dirPath, 'skill-card.md');
    if (fs.existsSync(cardPath)) {
      try {
        const cardContent = fs.readFileSync(cardPath, 'utf-8');
        if (!description || description === entry.name) {
          description = cardContent.split('\n')[0]?.replace(/^#+\s*/, '').trim() || description;
        }
      } catch { /* ignore */ }
    }

    results.push({
      name: entry.name,
      type: 'skill',
      description,
      version,
      source: 'claude-code',
      sourcePath: dirPath,
      config: { prompt },
      metadata,
    });
  }

  return results;
}

/** Scan local marketplace clone for available plugins */
export function scanMarketplacePlugins(): DiscoveredResource[] {
  const results: DiscoveredResource[] = [];

  if (!fs.existsSync(MARKETPLACE_DIR)) return results;

  // Scan external_plugins (MCP plugins)
  const externalDir = path.join(MARKETPLACE_DIR, 'external_plugins');
  if (fs.existsSync(externalDir)) {
    const entries = fs.readdirSync(externalDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(externalDir, entry.name);

      // Read plugin.json
      const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(pluginJsonPath)) continue;

      let pluginMeta: Record<string, unknown> = {};
      try {
        pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      } catch { continue; }

      // Read .mcp.json for MCP config
      let mcpConfig: Record<string, unknown> = {};
      const mcpJsonPath = path.join(pluginDir, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        try {
          mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        } catch { /* ignore */ }
      }

      // Also check for skills inside the plugin
      const skillsDir = path.join(pluginDir, 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const skillEntry of skillEntries) {
          if (!skillEntry.isDirectory()) continue;
          const skillDir = path.join(skillsDir, skillEntry.name);
          const skillMdPath = path.join(skillDir, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;

          let skillPrompt = '';
          try {
            const content = fs.readFileSync(skillMdPath, 'utf-8');
            const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
            skillPrompt = body;
          } catch { continue; }

          const skillName = `${pluginMeta.name}-${skillEntry.name}`;
          results.push({
            name: skillName,
            type: 'skill',
            description: `${pluginMeta.description || pluginMeta.name} — ${skillEntry.name} skill`,
            version: '1.0.0',
            source: 'marketplace',
            sourcePath: skillDir,
            config: { prompt: skillPrompt },
            metadata: { plugin: pluginMeta.name, pluginDir },
          });
        }
      }

      // Determine resource type
      const hasMcp = fs.existsSync(mcpJsonPath);
      const isAgent = !hasMcp && !fs.existsSync(path.join(pluginDir, 'skills'));

      // MCP plugin
      if (hasMcp) {
        const mcpServers = mcpConfig.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers) {
          for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
            const sc = serverConfig as Record<string, unknown>;
            results.push({
              name: `${pluginMeta.name}-${serverName}`,
              type: 'mcp',
              description: (pluginMeta.description as string) || `MCP: ${serverName}`,
              version: '1.0.0',
              source: 'marketplace',
              sourcePath: pluginDir,
              config: {
                command: sc.command || sc.type === 'stdio' ? 'npx' : undefined,
                url: sc.url,
                args: sc.args,
                env: sc.env,
              },
              metadata: { plugin: pluginMeta.name, pluginDir, serverName },
            });
          }
        } else {
          results.push({
            name: pluginMeta.name as string,
            type: 'mcp',
            description: (pluginMeta.description as string) || 'MCP plugin',
            version: '1.0.0',
            source: 'marketplace',
            sourcePath: pluginDir,
            config: mcpConfig,
            metadata: { plugin: pluginMeta.name, pluginDir },
          });
        }
      }

      // Agent/skill-only plugin (no MCP)
      if (isAgent && !fs.existsSync(path.join(pluginDir, 'skills'))) {
        results.push({
          name: pluginMeta.name as string,
          type: 'agent',
          description: (pluginMeta.description as string) || 'Agent plugin',
          version: '1.0.0',
          source: 'marketplace',
          sourcePath: pluginDir,
          config: { systemPrompt: pluginMeta.description || '' },
          metadata: { plugin: pluginMeta.name, pluginDir },
        });
      }
    }
  }

  // Scan plugins/ directory
  const pluginsDir = path.join(MARKETPLACE_DIR, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(pluginsDir, entry.name);
      const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(pluginJsonPath)) continue;

      let pluginMeta: Record<string, unknown> = {};
      try {
        pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      } catch { continue; }

      results.push({
        name: pluginMeta.name as string,
        type: 'agent',
        description: (pluginMeta.description as string) || 'Plugin',
        version: '1.0.0',
        source: 'marketplace',
        sourcePath: pluginDir,
        config: { systemPrompt: pluginMeta.description || '', tools: [] },
        metadata: { plugin: pluginMeta.name, pluginDir },
      });
    }
  }

  return results;
}

/** Scan MCP configs from ~/.claude/settings.json and ~/.claude/.mcp.json */
export function scanLocalMcps(): DiscoveredResource[] {
  const results: DiscoveredResource[] = [];

  // Check settings.json for MCP servers config
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        for (const [name, config] of Object.entries(settings.mcpServers)) {
          const cfg = config as Record<string, unknown>;
          results.push({
            name,
            type: 'mcp',
            description: `MCP server: ${name}`,
            version: '1.0.0',
            source: 'claude-code',
            sourcePath: settingsPath,
            config: {
              command: cfg.command,
              args: cfg.args,
              env: cfg.env,
              url: cfg.url,
            },
          });
        }
      }
    } catch { /* ignore */ }
  }

  return results;
}

/** Fetch plugin info from a GitHub URL */
export async function fetchGitHubPlugin(gitUrl: string): Promise<DiscoveredResource | null> {
  try {
    // Parse GitHub URL: https://github.com/owner/repo or owner/repo
    let ownerRepo = gitUrl;
    if (gitUrl.startsWith('https://github.com/')) {
      ownerRepo = gitUrl.replace('https://github.com/', '').replace(/\.git$/, '').replace(/\/$/, '');
    } else if (gitUrl.startsWith('github.com/')) {
      ownerRepo = gitUrl.replace('github.com/', '').replace(/\.git$/, '').replace(/\/$/, '');
    }

    const parts = ownerRepo.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;

    // Fetch plugin.json from the repo's default branch
    const pluginJsonUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/.claude-plugin/plugin.json`;
    const fallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/.claude-plugin/plugin.json`;

    let res = await fetch(pluginJsonUrl);
    if (!res.ok) {
      res = await fetch(fallbackUrl);
    }
    if (!res.ok) return null;

    const pluginMeta = await res.json();

    // Check for .mcp.json for MCP config
    const mcpJsonUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/.mcp.json`;
    let mcpConfig: Record<string, unknown> = {};
    try {
      const mcpRes = await fetch(mcpJsonUrl);
      if (mcpRes.ok) {
        mcpConfig = await mcpRes.json();
      }
    } catch { /* ignore */ }

    const hasMcp = Object.keys(mcpConfig).length > 0;

    return {
      name: pluginMeta.name || repo,
      type: hasMcp ? 'mcp' : 'skill',
      description: pluginMeta.description || `${owner}/${repo}`,
      version: '1.0.0',
      source: 'git',
      sourcePath: gitUrl,
      config: hasMcp ? mcpConfig : { prompt: pluginMeta.description || '' },
      metadata: { owner, repo, pluginMeta },
    };
  } catch {
    return null;
  }
}

/** Scan a local directory for installed skills and MCP plugins */
export function scanDirectory(dirPath: string): DiscoveredResource[] {
  const results: DiscoveredResource[] = [];

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return results;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(dirPath, entry.name);

    // ---- Pattern 1: Skill directory (contains SKILL.md) ----
    const skillMdPath = path.join(subDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        let description = '';
        let name = entry.name;
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
          const fm = frontmatterMatch[1];
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim();
        }
        if (!description) {
          description = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim().split('\n')[0]?.replace(/^#+\s*/, '') || name;
        }
        const prompt = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

        // Read _meta.json for version
        let version = '1.0.0';
        const metaPath = path.join(subDir, '_meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            if (meta.version) version = meta.version as string;
          } catch { /* ignore */ }
        }

        results.push({
          name,
          type: 'skill',
          description,
          version,
          source: 'import',
          sourcePath: subDir,
          config: { prompt },
        });
        continue;
      } catch (err) {
        console.warn(`[scanner] Skipping skill ${entry.name}:`, (err as Error).message);
      }
    }

    // ---- Pattern 2: Plugin directory (.claude-plugin/plugin.json) ----
    const pluginJsonPath = path.join(subDir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      try {
        const pluginMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));

        // Check for .mcp.json
        const mcpJsonPath = path.join(subDir, '.mcp.json');
        let mcpConfig: Record<string, unknown> = {};
        if (fs.existsSync(mcpJsonPath)) {
          try {
            mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
          } catch { /* ignore */ }
        }

        // Also scan nested skills
        const skillsDir = path.join(subDir, 'skills');
        if (fs.existsSync(skillsDir)) {
          const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const skillEntry of skillEntries) {
            if (!skillEntry.isDirectory()) continue;
            const skillDir = path.join(skillsDir, skillEntry.name);
            const skillMd = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillMd)) continue;

            try {
              const sContent = fs.readFileSync(skillMd, 'utf-8');
              const sPrompt = sContent.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
              const sName = `${pluginMeta.name}-${skillEntry.name}`;
              results.push({
                name: sName,
                type: 'skill',
                description: `${pluginMeta.description || pluginMeta.name} — ${skillEntry.name}`,
                version: '1.0.0',
                source: 'import',
                sourcePath: skillDir,
                config: { prompt: sPrompt },
              });
            } catch { /* ignore */ }
          }
        }

        // Add the plugin itself as MCP or agent
        if (Object.keys(mcpConfig).length > 0) {
          const mcpServers = mcpConfig.mcpServers as Record<string, unknown> | undefined;
          if (mcpServers) {
            for (const [srvName, srvCfg] of Object.entries(mcpServers)) {
              const sc = srvCfg as Record<string, unknown>;
              results.push({
                name: `${pluginMeta.name}-${srvName}`,
                type: 'mcp',
                description: pluginMeta.description || `${pluginMeta.name} MCP`,
                version: '1.0.0',
                source: 'import',
                sourcePath: subDir,
                config: sc as Record<string, unknown>,
              });
            }
          } else {
            results.push({
              name: pluginMeta.name as string,
              type: 'mcp',
              description: pluginMeta.description || '',
              version: '1.0.0',
              source: 'import',
              sourcePath: subDir,
              config: mcpConfig,
            });
          }
        } else {
          results.push({
            name: pluginMeta.name as string,
            type: 'agent',
            description: pluginMeta.description || '',
            version: '1.0.0',
            source: 'import',
            sourcePath: subDir,
            config: { systemPrompt: pluginMeta.description || '', tools: [] },
          });
        }
        continue;
      } catch (err) {
        console.warn(`[scanner] Skipping plugin ${entry.name}:`, (err as Error).message);
      }
    }

    // ---- Pattern 3: Plain .mcp.json in a subdirectory ----
    const mcpJsonPath = path.join(subDir, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        const mcpServers = mcpConfig.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers) {
          for (const [srvName, srvCfg] of Object.entries(mcpServers)) {
            const sc = srvCfg as Record<string, unknown>;
            results.push({
              name: `${entry.name}-${srvName}`,
              type: 'mcp',
              description: `MCP server: ${srvName}`,
              version: '1.0.0',
              source: 'import',
              sourcePath: subDir,
              config: sc as Record<string, unknown>,
            });
          }
        }
        continue;
      } catch (err) {
        console.warn(`[scanner] Skipping MCP ${entry.name}:`, (err as Error).message);
      }
    }
  }

  // ---- Also check top-level .yaml/.yml/.json files (flat resource definitions) ----
  const files = fs.readdirSync(dirPath).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')
  );
  for (const file of files) {
    try {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      let parsed: Record<string, unknown>;
      if (file.endsWith('.json')) {
        parsed = JSON.parse(content);
      } else {
        const yaml = require('js-yaml');
        parsed = yaml.load(content) as Record<string, unknown>;
      }
      if (!parsed || !parsed.name) continue;
      // Avoid duplicates (already picked up as a skill/plugin directory)
      if (results.some(r => r.name === parsed.name)) continue;
      results.push({
        name: parsed.name as string,
        type: (parsed.type as DiscoveredResource['type']) || 'skill',
        description: (parsed.description as string) || '',
        version: (parsed.version as string) || '1.0.0',
        source: 'import',
        sourcePath: filePath,
        config: (parsed.config as Record<string, unknown>) || {},
      });
    } catch (err) {
      console.warn(`[scanner] Skipping ${file}:`, (err as Error).message);
    }
  }

  return results;
}
