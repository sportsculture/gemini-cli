/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadServerHierarchicalMemory } from './memoryDiscovery.js';
import {
  SPRTSCLTR_CONFIG_DIR,
  setGeminiMdFilename,
  DEFAULT_CONTEXT_FILENAME,
} from '../tools/memoryTool.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

vi.mock('fs/promises');

describe('loadServerHierarchicalMemory', () => {
  let testRootDir: string;
  let cwd: string;
  let projectRoot: string;
  let homedir: string;

  const mockFs = fsPromises as any;

  async function createEmptyDir(fullPath: string) {
    await fsPromises.mkdir(fullPath, { recursive: true });
    return fullPath;
  }

  async function createTestFile(filePath: string, content: string) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content);
    return filePath;
  }

  let GLOBAL_SPRTSCLTR_DIR: string;
  let GLOBAL_GEMINI_FILE: string; // Defined in beforeEach

  beforeEach(async () => {
    vi.resetAllMocks();
    // Set environment variables to indicate test environment
    process.env.NODE_ENV = 'test';
    process.env.VITEST = 'true';

    // Create temp directory structure
    testRootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'test-'));
    projectRoot = await createEmptyDir(path.join(testRootDir, 'project'));
    cwd = await createEmptyDir(path.join(projectRoot, 'src'));
    homedir = await createEmptyDir(path.join(testRootDir, 'userhome'));
    vi.mocked(os.homedir).mockReturnValue(homedir);

    // Define these here to use potentially reset/updated values from imports
    GLOBAL_SPRTSCLTR_DIR = path.join(homedir, SPRTSCLTR_CONFIG_DIR);
    GLOBAL_GEMINI_FILE = path.join(
      GLOBAL_SPRTSCLTR_DIR,
      DEFAULT_CONTEXT_FILENAME,
    );

    // Setup default mocks
    mockFs.stat.mockRejectedValue(new Error('File not found'));
    mockFs.readdir.mockResolvedValue([]);
    mockFs.readFile.mockRejectedValue(new Error('File not found'));
    mockFs.access.mockRejectedValue(new Error('File not found'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.mkdtemp.mockImplementation((prefix: string) =>
      Promise.resolve(prefix + Math.random().toString(36).substring(7)),
    );
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Clean up temp directory
    if (testRootDir) {
      try {
        await fsPromises.rm(testRootDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should return empty memory and count if no context files are found', async () => {
    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: '',
      fileCount: 0,
    });
  });

  it('should load only the global context file if present and others are not (default filename)', async () => {
    const globalDefaultFile = path.join(
      GLOBAL_SPRTSCLTR_DIR,
      DEFAULT_CONTEXT_FILENAME,
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, path.join(GLOBAL_SPRTSCLTR_DIR, DEFAULT_CONTEXT_FILENAME))} ---
default context content
--- End of Context from: ${path.relative(cwd, path.join(GLOBAL_SPRTSCLTR_DIR, DEFAULT_CONTEXT_FILENAME))} ---`,
      fileCount: 1,
    });
  });

  it('should load only the global custom context file if present and filename is changed', async () => {
    const customFilename = 'CUSTOM_AGENTS.md';
    setGeminiMdFilename(customFilename);
    const globalCustomFile = path.join(GLOBAL_SPRTSCLTR_DIR, customFilename);

    const customContextFile = await createTestFile(
      path.join(homedir, SPRTSCLTR_CONFIG_DIR, customFilename),
      'custom context content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, customContextFile)} ---
custom context content
--- End of Context from: ${path.relative(cwd, customContextFile)} ---`,
      fileCount: 1,
    });
  });

  it('should load context files by upward traversal with custom filename', async () => {
    const customFilename = 'PROJECT_CONTEXT.md';
    setGeminiMdFilename(customFilename);

    const projectContextFile = await createTestFile(
      path.join(projectRoot, customFilename),
      'project context content',
    );
    const cwdContextFile = await createTestFile(
      path.join(cwd, customFilename),
      'cwd context content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, projectContextFile)} ---
project context content
--- End of Context from: ${path.relative(cwd, projectContextFile)} ---

--- Context from: ${path.relative(cwd, cwdContextFile)} ---
cwd context content
--- End of Context from: ${path.relative(cwd, cwdContextFile)} ---`,
      fileCount: 2,
    });
  });

  it('should load context files by downward traversal with custom filename', async () => {
    const customFilename = 'LOCAL_CONTEXT.md';
    setGeminiMdFilename(customFilename);

    await createTestFile(
      path.join(cwd, 'subdir', customFilename),
      'Subdir custom memory',
    );
    await createTestFile(path.join(cwd, customFilename), 'CWD custom memory');

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${customFilename} ---
CWD custom memory
--- End of Context from: ${customFilename} ---

--- Context from: ${path.join('subdir', customFilename)} ---
Subdir custom memory
--- End of Context from: ${path.join('subdir', customFilename)} ---`,
      fileCount: 2,
    });
  });

  it('should load ORIGINAL_GEMINI_MD_FILENAME files by upward traversal from CWD to project root', async () => {
    const projectRootGeminiFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'Project root memory',
    );
    const srcGeminiFile = await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'Src directory memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, projectRootGeminiFile)} ---
Project root memory
--- End of Context from: ${path.relative(cwd, projectRootGeminiFile)} ---

--- Context from: ${path.relative(cwd, srcGeminiFile)} ---
Src directory memory
--- End of Context from: ${path.relative(cwd, srcGeminiFile)} ---`,
      fileCount: 2,
    });
  });

  it('should load ORIGINAL_GEMINI_MD_FILENAME files by downward traversal from CWD', async () => {
    await createTestFile(
      path.join(cwd, 'subdir', DEFAULT_CONTEXT_FILENAME),
      'Subdir memory',
    );
    await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'CWD memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${DEFAULT_CONTEXT_FILENAME} ---
CWD memory
--- End of Context from: ${DEFAULT_CONTEXT_FILENAME} ---

--- Context from: ${path.join('subdir', DEFAULT_CONTEXT_FILENAME)} ---
Subdir memory
--- End of Context from: ${path.join('subdir', DEFAULT_CONTEXT_FILENAME)} ---`,
      fileCount: 2,
    });
  });

  it('should load and correctly order global, upward, and downward ORIGINAL_GEMINI_MD_FILENAME files', async () => {
    setGeminiMdFilename(DEFAULT_CONTEXT_FILENAME); // Explicitly set for this test

    const globalFileToUse = path.join(
      GLOBAL_SPRTSCLTR_DIR,
      DEFAULT_CONTEXT_FILENAME,
    );
    const rootGeminiFile = await createTestFile(
      path.join(testRootDir, DEFAULT_CONTEXT_FILENAME),
      'Project parent memory',
    );
    const projectRootGeminiFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'Project root memory',
    );
    const cwdGeminiFile = await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'CWD memory',
    );
    const subDirGeminiFile = await createTestFile(
      path.join(cwd, 'sub', DEFAULT_CONTEXT_FILENAME),
      'Subdir memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, path.join(GLOBAL_SPRTSCLTR_DIR, DEFAULT_CONTEXT_FILENAME))} ---
default context content
--- End of Context from: ${path.relative(cwd, path.join(GLOBAL_SPRTSCLTR_DIR, DEFAULT_CONTEXT_FILENAME))} ---

--- Context from: ${path.relative(cwd, rootGeminiFile)} ---
Project parent memory
--- End of Context from: ${path.relative(cwd, rootGeminiFile)} ---

--- Context from: ${path.relative(cwd, projectRootGeminiFile)} ---
Project root memory
--- End of Context from: ${path.relative(cwd, projectRootGeminiFile)} ---

--- Context from: ${path.relative(cwd, cwdGeminiFile)} ---
CWD memory
--- End of Context from: ${path.relative(cwd, cwdGeminiFile)} ---

--- Context from: ${path.relative(cwd, subDirGeminiFile)} ---
Subdir memory
--- End of Context from: ${path.relative(cwd, subDirGeminiFile)} ---`,
      fileCount: 5,
    });
  });

  it('should ignore specified directories during downward scan', async () => {
    await createEmptyDir(path.join(projectRoot, '.git'));
    await createTestFile(path.join(projectRoot, '.gitignore'), 'node_modules');

    await createTestFile(
      path.join(cwd, 'node_modules', DEFAULT_CONTEXT_FILENAME),
      'Ignored memory',
    );
    const regularSubDirGeminiFile = await createTestFile(
      path.join(cwd, 'my_code', DEFAULT_CONTEXT_FILENAME),
      'My code memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
      [],
      {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
      },
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, regularSubDirGeminiFile)} ---
My code memory
--- End of Context from: ${path.relative(cwd, regularSubDirGeminiFile)} ---`,
      fileCount: 1,
    });
  });

  it('should respect the maxDirs parameter during downward scan', async () => {
    const consoleDebugSpy = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => {});

    for (let i = 0; i < 100; i++) {
      await createEmptyDir(path.join(cwd, `deep_dir_${i}`));
    }

    // Pass the custom limit directly to the function
    await loadServerHierarchicalMemory(
      cwd,
      true,
      new FileDiscoveryService(projectRoot),
      [],
      {
        respectGitIgnore: true,
        respectGeminiIgnore: true,
      },
      50, // maxDirs
    );

    expect(consoleDebugSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DEBUG] [BfsFileSearch]'),
      expect.stringContaining('Scanning [50/50]:'),
    );

    vi.mocked(console.debug).mockRestore();
  });

  it('should load extension context file paths', async () => {
    const extensionFilePath = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/GEMINI.md'),
      'Extension memory content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      false,
      new FileDiscoveryService(projectRoot),
      [extensionFilePath],
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, extensionFilePath)} ---
Extension memory content
--- End of Context from: ${path.relative(cwd, extensionFilePath)} ---`,
      fileCount: 1,
    });
  });
});
