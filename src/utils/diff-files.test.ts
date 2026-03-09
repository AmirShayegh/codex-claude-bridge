import { describe, it, expect } from 'vitest';
import { extractFilesFromDiff } from './diff-files.js';

describe('extractFilesFromDiff', () => {
  it('extracts single file path', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+new line`;
    expect(extractFilesFromDiff(diff)).toEqual(['src/foo.ts']);
  });

  it('extracts multiple file paths', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+new line
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,4 @@
+another line`;
    expect(extractFilesFromDiff(diff)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('deduplicates paths', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/foo.ts b/src/foo.ts
@@ -10 +10 @@
-old2
+new2`;
    expect(extractFilesFromDiff(diff)).toEqual(['src/foo.ts']);
  });

  it('handles renamed files (uses b/ path)', () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts`;
    expect(extractFilesFromDiff(diff)).toEqual(['new-name.ts']);
  });

  it('returns empty array for empty diff', () => {
    expect(extractFilesFromDiff('')).toEqual([]);
  });

  it('returns empty array for diff with no git headers', () => {
    expect(extractFilesFromDiff('just some text\nno headers here')).toEqual([]);
  });

  it('handles paths with spaces', () => {
    const diff = `diff --git a/src/my file.ts b/src/my file.ts
--- a/src/my file.ts
+++ b/src/my file.ts
@@ -1 +1 @@
-old`;
    expect(extractFilesFromDiff(diff)).toEqual(['src/my file.ts']);
  });

  it('handles deeply nested paths', () => {
    const diff = `diff --git a/src/config/loaders/json.ts b/src/config/loaders/json.ts
@@ -1 +1 @@
-old`;
    expect(extractFilesFromDiff(diff)).toEqual(['src/config/loaders/json.ts']);
  });
});
