// Validates profile.config.json before the build fetches anything.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const THEME_KEYS = ['void', 'surface', 'rule', 'ink', 'quiet', 'signal', 'dotDim', 'dotMid'];

export function validateConfig(config) {
  const errors = [];
  const text = (value, path) => {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${path} must be a non-empty string`);
    }
  };
  const repos = (value, path, counts) => {
    const allowed = Array.isArray(counts) ? counts : [counts];
    if (!Array.isArray(value) || !allowed.includes(value.length)) {
      errors.push(`${path} must list ${allowed.join(' or ')} repositories`);
      return;
    }
    value.forEach((repo, i) => {
      if (typeof repo !== 'string' || !REPO.test(repo)) {
        errors.push(`${path}[${i}] must be "owner/name"`);
      }
    });
  };

  text(config.username, 'username');
  const profile = config.profile ?? {};
  for (const key of ['name', 'intro', 'closing']) {
    text(profile[key], `profile.${key}`);
  }

  if (config.theme !== undefined) {
    if (typeof config.theme !== 'object' || config.theme === null || Array.isArray(config.theme)) {
      errors.push('theme must be an object');
    } else {
      for (const key of THEME_KEYS) {
        if (config.theme[key] !== undefined && (typeof config.theme[key] !== 'string' || !HEX.test(config.theme[key]))) {
          errors.push(`theme.${key} must be a 6-digit hex color like #1269cc`);
        }
      }
    }
  }

  repos(config.featured, 'featured', [2, 4]);
  repos(config.more, 'more', 4);

  if (config.descriptions !== undefined) {
    if (typeof config.descriptions !== 'object' || config.descriptions === null || Array.isArray(config.descriptions)) {
      errors.push('descriptions must be an object');
    } else {
      for (const [repo, desc] of Object.entries(config.descriptions)) {
        if (typeof desc !== 'string') {
          errors.push(`descriptions["${repo}"] must be a string`);
        }
      }
    }
  }

  if (!Array.isArray(config.links) || config.links.length < 1 || config.links.length > 4) {
    errors.push('links must have 1 to 4 entries');
  } else {
    config.links.forEach((link, i) => {
      text(link?.label, `links[${i}].label`);
      if (typeof link?.url !== 'string' || !link.url.startsWith('https://')) {
        errors.push(`links[${i}].url must be an https URL`);
      }
    });
  }

  return errors;
}

export function readConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid ${path}:\n- ${errors.join('\n- ')}`);
  }
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readConfig('profile.config.json');
  console.log('profile.config.json is valid');
}
