import contextlib
import filecmp
import glob
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tools import wiki


class PlanSyncTests(unittest.TestCase):
    def setUp(self):
        self.src = tempfile.mkdtemp()
        self.dst = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.src, ignore_errors=True)
        shutil.rmtree(self.dst, ignore_errors=True)

    def write(self, root, name, text):
        with open(os.path.join(root, name), "w") as fh:
            fh.write(text)

    def test_an_empty_wiki_makes_every_page_an_add(self):
        self.write(self.src, "Home.md", "# Home\n")
        self.write(self.src, "Runbooks.md", "# Runbooks\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(adds, ["Home.md", "Runbooks.md"])
        self.assertEqual(updates, [])
        self.assertEqual(deletes, [])

    def test_identical_content_is_neither_an_add_nor_an_update(self):
        self.write(self.src, "Home.md", "# Home\n")
        self.write(self.dst, "Home.md", "# Home\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual((adds, updates, deletes), ([], [], []))

    def test_changed_content_is_an_update(self):
        self.write(self.src, "Home.md", "# Home\n")
        self.write(self.dst, "Home.md", "# Old\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(updates, ["Home.md"])
        self.assertEqual(adds, [])

    def test_a_page_gone_from_source_is_a_delete(self):
        self.write(self.dst, "Stale.md", "# Stale\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(deletes, ["Stale.md"])

    def test_the_wikis_own_git_directory_is_never_touched(self):
        os.makedirs(os.path.join(self.dst, ".git"))
        self.write(os.path.join(self.dst, ".git"), "config", "x")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(deletes, [])

    def test_images_travel_with_the_pages(self):
        self.write(self.src, "shot.png", "notreallyapng")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(adds, ["shot.png"])

    def test_gitattributes_file_in_wiki_is_not_deleted(self):
        self.write(self.dst, ".gitattributes", "* text=auto\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(deletes, [])

    def test_ds_store_file_in_source_is_not_added(self):
        self.write(self.src, ".DS_Store", "junk")
        self.write(self.src, "Home.md", "# Home\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(adds, ["Home.md"])
        self.assertNotIn(".DS_Store", adds)

    def test_subdirectory_in_source_is_not_published(self):
        os.makedirs(os.path.join(self.src, "subdir"))
        self.write(os.path.join(self.src, "subdir"), "file.md", "# File\n")
        self.write(self.src, "Home.md", "# Home\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(adds, ["Home.md"])
        self.assertNotIn("subdir", adds)

    def test_subdirectory_in_wiki_is_not_deleted(self):
        os.makedirs(os.path.join(self.dst, "subdir"))
        self.write(os.path.join(self.dst, "subdir"), "file.md", "# File\n")
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(deletes, [])

    def test_identical_size_different_content_detected_as_update(self):
        self.write(self.src, "Home.md", "aaaabbbbcccc")
        self.write(self.dst, "Home.md", "ddddeeeeffff")
        # Same size, different content.  The two writes above land at
        # different instants, so their mtimes already differ -- and a
        # shallow (stat-only) comparison would report "unequal" from the
        # mtime alone, letting this test pass whether or not the tool
        # actually reads file content.  Force the mtimes identical so the
        # only remaining difference is content, which is what this test
        # means to pin.
        dst_path = os.path.join(self.dst, "Home.md")
        src_path = os.path.join(self.src, "Home.md")
        dst_stat = os.stat(dst_path)
        os.utime(src_path, ns=(dst_stat.st_atime_ns, dst_stat.st_mtime_ns))
        filecmp.clear_cache()
        adds, updates, deletes = wiki.plan_sync(self.src, self.dst)
        self.assertEqual(updates, ["Home.md"])
        self.assertEqual(adds, [])
        self.assertEqual(deletes, [])


class SidebarNameTests(unittest.TestCase):
    def test_forgejo_wants_a_capital_s(self):
        self.assertEqual(wiki.target_name("_Sidebar.md", "forgejo"), "_Sidebar.md")

    def test_gitlab_wants_it_lowercase(self):
        self.assertEqual(wiki.target_name("_Sidebar.md", "gitlab"), "_sidebar.md")

    def test_every_other_page_keeps_its_name(self):
        self.assertEqual(wiki.target_name("Home.md", "gitlab"), "Home.md")
        self.assertEqual(wiki.target_name("Home.md", "forgejo"), "Home.md")


class SubstituteTests(unittest.TestCase):
    def test_the_repo_token_becomes_the_base_url(self):
        out = wiki.substitute("see [x]({{REPO}}/README.md#studio)", "https://h/o/r")
        self.assertEqual(out, "see [x](https://h/o/r/README.md#studio)")

    def test_every_occurrence_is_replaced(self):
        out = wiki.substitute("{{REPO}}/a {{REPO}}/b", "B")
        self.assertEqual(out, "B/a B/b")

    def test_text_without_the_token_is_unchanged(self):
        self.assertEqual(wiki.substitute("plain", "B"), "plain")

    def test_a_trailing_slash_on_the_base_does_not_double(self):
        out = wiki.substitute("{{REPO}}/README.md", "https://h/o/r/")
        self.assertEqual(out, "https://h/o/r/README.md")


class PublishableTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, name, text):
        with open(os.path.join(self.root, name), "w") as fh:
            fh.write(text)

    def mkdir(self, name):
        os.makedirs(os.path.join(self.root, name))

    def test_dot_files_are_not_publishable(self):
        self.write(".gitattributes", "* text=auto\n")
        self.write("Home.md", "# Home\n")
        result = wiki.publishable(self.root)
        self.assertEqual(result, ["Home.md"])

    def test_ds_store_is_not_publishable(self):
        self.write(".DS_Store", "junk")
        self.write("Home.md", "# Home\n")
        result = wiki.publishable(self.root)
        self.assertEqual(result, ["Home.md"])

    def test_directories_are_not_publishable(self):
        self.mkdir("subdir")
        self.write("Home.md", "# Home\n")
        result = wiki.publishable(self.root)
        self.assertEqual(result, ["Home.md"])


class MainTests(unittest.TestCase):
    def setUp(self):
        # Record pre-existing wiki-* dirs so we only detect NEW leaks
        temp_root = tempfile.gettempdir()
        self.preexisting_leaks = set(glob.glob(os.path.join(temp_root, "wiki-*")))

        self.src = tempfile.mkdtemp()
        self.bare_repo = tempfile.mkdtemp()
        subprocess.check_call(["git", "init", "--bare", "-q"], cwd=self.bare_repo)

        # git needs a committer identity for the subprocess calls.  Patched
        # rather than assigned: a bare assignment outlives the test and
        # every later test in the process inherits it.
        patch = mock.patch.dict(os.environ, {
            "GIT_AUTHOR_NAME": "Test Author",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test Committer",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        })
        patch.start()
        self.addCleanup(patch.stop)

    def tearDown(self):
        shutil.rmtree(self.src, ignore_errors=True)
        shutil.rmtree(self.bare_repo, ignore_errors=True)
        # wiki.py must clean up its own staging and clone directories on
        # every path, including the error paths.  Report only - a
        # concurrent wiki.py run or a second test process owns any
        # directory this one did not create, and deleting on suspicion
        # would destroy live work to tidy a temp dir.
        temp_root = tempfile.gettempdir()
        all_leaks = set(glob.glob(os.path.join(temp_root, "wiki-*")))
        new_leaks = all_leaks - self.preexisting_leaks
        if new_leaks:
            self.fail("wiki.py leaked temp directories: %s" % sorted(new_leaks))

    def write(self, root, name, text):
        with open(os.path.join(root, name), "w") as fh:
            fh.write(text)

    def call_main_suppressed(self, argv):
        """Call wiki.main() while suppressing git's stderr warnings."""
        devnull = os.open(os.devnull, os.O_WRONLY)
        old_stderr = os.dup(2)
        os.dup2(devnull, 2)
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ret = wiki.main(argv)
            return ret, out.getvalue()
        finally:
            os.dup2(old_stderr, 2)
            os.close(devnull)
            os.close(old_stderr)

    def test_check_mode_reports_adds_without_pushing(self):
        self.write(self.src, "Home.md", "# Home\n")
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src,
            "--check"
        ]
        ret, output = self.call_main_suppressed(argv)
        self.assertEqual(ret, 0)
        self.assertIn("add", output)

        # Verify the bare repo still has no commits
        try:
            subprocess.check_output(
                ["git", "--git-dir=" + self.bare_repo, "rev-parse", "HEAD"],
                stderr=subprocess.PIPE)
            self.fail("Expected no commits in bare repo")
        except subprocess.CalledProcessError:
            pass  # Expected: no commits yet

    def test_publish_adds_content_to_remote(self):
        self.write(self.src, "Home.md", "# Home\n")
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src
        ]
        ret, output = self.call_main_suppressed(argv)
        self.assertEqual(ret, 0)
        self.assertIn("pushed", output)

        # Verify content in bare repo
        content = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "show", "HEAD:Home.md"])
        self.assertEqual(content.decode("utf-8"), "# Home\n")

    def test_second_publish_with_no_change_reports_already_up_to_date(self):
        self.write(self.src, "Home.md", "# Home\n")
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src
        ]
        # First publish
        ret1, _ = self.call_main_suppressed(argv)
        self.assertEqual(ret1, 0)
        commit1 = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "rev-parse", "HEAD"])

        # Second publish with no changes
        ret2, output2 = self.call_main_suppressed(argv)
        self.assertEqual(ret2, 0)
        self.assertIn("already up to date", output2)
        commit2 = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "rev-parse", "HEAD"])

        # Should be the same commit (no new one created)
        self.assertEqual(commit1, commit2)

    def test_repo_token_substituted_in_markdown(self):
        self.write(self.src, "Guide.md", "See [README]({{REPO}}/README.md)\n")
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src
        ]
        ret, _ = self.call_main_suppressed(argv)
        self.assertEqual(ret, 0)

        content = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "show", "HEAD:Guide.md"])
        self.assertEqual(content.decode("utf-8"), "See [README](https://example.com/repo/README.md)\n")

    def test_non_markdown_copied_byte_for_byte(self):
        binary_content = b"\x89PNG\r\n\x1a\n"
        with open(os.path.join(self.src, "shot.png"), "wb") as fh:
            fh.write(binary_content)
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src
        ]
        ret, _ = self.call_main_suppressed(argv)
        self.assertEqual(ret, 0)

        content = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "show", "HEAD:shot.png"])
        self.assertEqual(content, binary_content)

    def test_identical_size_different_content_detected_as_update(self):
        # Create initial content
        self.write(self.src, "Home.md", "aaaabbbbcccc")
        argv = [
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src
        ]
        # First publish
        ret1, _ = self.call_main_suppressed(argv)
        self.assertEqual(ret1, 0)
        commit1 = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "rev-parse", "HEAD"])

        # Change content but keep same size
        self.write(self.src, "Home.md", "ddddeeeeffff")

        # main() clones the wiki and stages the new content into two
        # fresh temp dirs a moment apart, so their mtimes already differ
        # on their own -- a shallow (stat-only) comparison would report
        # "unequal" from that mtime gap alone and this test would pass
        # whether or not the tool actually reads file content.  Splice in
        # a wrapper around the real plan_sync that forces the staged
        # file's mtime to match the freshly cloned one, immediately
        # before the real comparison runs, so the only remaining
        # difference between the two is content -- which is what this
        # test means to pin. Everything else about the publish (the
        # clone, the staging, the commit, the push) still runs for real.
        real_plan_sync = wiki.plan_sync

        def plan_sync_with_forced_mtime(source_dir, wiki_dir):
            dst_stat = os.stat(os.path.join(wiki_dir, "Home.md"))
            os.utime(os.path.join(source_dir, "Home.md"),
                     ns=(dst_stat.st_atime_ns, dst_stat.st_mtime_ns))
            filecmp.clear_cache()
            return real_plan_sync(source_dir, wiki_dir)

        # Second publish with different content (same size)
        with mock.patch.object(wiki, "plan_sync",
                               side_effect=plan_sync_with_forced_mtime):
            ret2, output2 = self.call_main_suppressed(argv)
        self.assertEqual(ret2, 0)
        self.assertIn("update", output2)
        commit2 = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "rev-parse", "HEAD"])

        # Should be different commit (update detected)
        self.assertNotEqual(commit1, commit2)

        # Verify new content
        content = subprocess.check_output(
            ["git", "--git-dir=" + self.bare_repo, "show", "HEAD:Home.md"])
        self.assertEqual(content.decode("utf-8"), "ddddeeeeffff")

    def _published(self):
        """Filenames on the bare remote's tip, via a throwaway clone."""
        dest = tempfile.mkdtemp()
        try:
            subprocess.check_call(["git", "clone", "-q", self.bare_repo, dest],
                                  stderr=subprocess.DEVNULL)
            return sorted(n for n in os.listdir(dest) if not n.startswith("."))
        finally:
            shutil.rmtree(dest, ignore_errors=True)

    def _publish(self, flavor):
        return self.call_main_suppressed([
            "--remote", self.bare_repo,
            "--repo-url", "https://example.com/repo",
            "--source", self.src,
            "--flavor", flavor,
        ])

    def test_flavor_switch_renames_the_sidebar_and_keeps_exactly_one(self):
        """A gitlab publish over a forgejo wiki must leave _sidebar.md.

        The two names differ only in case.  On a case-insensitive
        filesystem - macOS, where this tool is meant to run - writing the
        add lands in the existing file's inode, so removing the old name
        afterwards deletes the file that was just written and the wiki
        loses its sidebar entirely while the run reports success.
        """
        self.write(self.src, "Home.md", "# Home\n")
        self.write(self.src, "_Sidebar.md", "- [Home](Home)\n")

        ret, _ = self._publish("forgejo")
        self.assertEqual(ret, 0)
        self.assertEqual(self._published(), ["Home.md", "_Sidebar.md"])

        ret, _ = self._publish("gitlab")
        self.assertEqual(ret, 0)
        self.assertEqual(self._published(), ["Home.md", "_sidebar.md"])

    def test_a_page_dropped_from_source_is_deleted_from_the_wiki(self):
        """The delete path, end to end - no test drove it through main()."""
        self.write(self.src, "Home.md", "# Home\n")
        self.write(self.src, "Doomed.md", "# Doomed\n")
        self.assertEqual(self._publish("forgejo")[0], 0)
        self.assertEqual(self._published(), ["Doomed.md", "Home.md"])

        os.remove(os.path.join(self.src, "Doomed.md"))
        self.assertEqual(self._publish("forgejo")[0], 0)
        self.assertEqual(self._published(), ["Home.md"])
