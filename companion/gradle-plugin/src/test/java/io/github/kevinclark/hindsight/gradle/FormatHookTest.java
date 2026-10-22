package io.github.kevinclark.hindsight.gradle;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FormatHookTest {
  private static final String MARKER = "# Hindsight format hook";
  private static final String HOOK = ".git/hooks/pre-commit";
  private static final String FORMATTED = "src/main/java/frc/robot/Formatted.java";
  private static final String TAB = "\t";

  // Formats like a Spotless run: tabs become two spaces in every Java file under src
  private static final String FORMATTING_GRADLEW = String.join("\n",
      "tab=$(printf '\\t')",
      "find src -name '*.java' | while IFS= read -r f; do",
      "  sed \"s/$tab/  /g\" \"$f\" > \"$f.tmp\" && mv \"$f.tmp\" \"$f\"",
      "done",
      "");

  @TempDir Path dir;

  private Sample hooked(String... settings) {
    Sample sample = Sample.in(dir).buildLine("tasks.register('spotlessApply')");
    for (String setting : settings) sample.setting(setting);
    return sample.gitInit();
  }

  private static String source(String body) {
    return "package frc.robot;\n\npublic class Formatted {\n" + body + "}\n";
  }

  @Test
  void installsAnExecutableHook() {
    Sample sample = hooked();
    sample.build(false, "compileJava");

    assertTrue(sample.read(HOOK).contains(MARKER));
    assertTrue(Files.isExecutable(sample.file(HOOK)));
  }

  @Test
  void noHookInCi() {
    Sample sample = hooked("strictInCi = false"); // so the CI build passes and the hook is the only thing in question
    sample.build(true, "compileJava");

    assertFalse(Files.exists(sample.file(HOOK)));
  }

  @Test
  void noHookWhenHooksPathIsSet() {
    Sample sample = hooked();
    sample.git("config", "core.hooksPath", ".githooks");
    sample.build(false, "compileJava");

    assertFalse(Files.exists(sample.file(HOOK)));
  }

  @Test
  void anotherPreCommitIsLeftByteIdentical() throws IOException {
    Sample sample = hooked();
    String theirs = "#!/bin/sh\necho theirs\n";
    sample.write(HOOK, theirs);
    sample.build(false, "compileJava");

    assertEquals(theirs, sample.read(HOOK));
  }

  @Test
  void turningTheHookOffRemovesIt() {
    hooked().build(false, "compileJava");
    Sample off = Sample.in(dir).buildLine("tasks.register('spotlessApply')").setting("formatHook = false");
    off.build(false, "compileJava");

    assertFalse(Files.exists(off.file(HOOK)));
  }

  @Test
  void turningTheHookOffLeavesSomeoneElsesAlone() {
    Sample off = hooked("formatHook = false");
    String theirs = "#!/bin/sh\necho theirs\n";
    off.write(HOOK, theirs);
    off.build(false, "compileJava");

    assertEquals(theirs, off.read(HOOK));
  }

  @Test
  void noHookWhenTheBuildFileIsNotTracked() {
    Sample sample = Sample.in(dir).buildLine("tasks.register('spotlessApply')").write();
    sample.git("init", "-q");
    sample.build(false, "compileJava");

    assertFalse(Files.exists(sample.file(HOOK)));
  }

  @Test
  void noHookWithoutSpotless() {
    Sample sample = Sample.in(dir).gitInit();
    sample.build(false, "compileJava");

    assertFalse(Files.exists(sample.file(HOOK)));
  }

  @Test
  void commitHasTheFormattedVersionOfAFullyStagedFile() {
    Sample sample = installedWithGradlew(FORMATTING_GRADLEW);
    sample.write(FORMATTED, source(TAB + "int x;\n"));
    sample.git("add", FORMATTED);
    sample.git("commit", "-q", "-m", "format");

    assertEquals(source("  int x;\n"), sample.git("show", "HEAD:" + FORMATTED).output());
    assertEquals("", sample.git("status", "--porcelain", "--", FORMATTED).output());
  }

  @Test
  void partiallyStagedFileIsCommittedAsStaged() {
    Sample sample = installedWithGradlew(FORMATTING_GRADLEW);
    sample.write(FORMATTED, source(""));
    sample.git("add", FORMATTED);
    sample.git("commit", "-q", "-m", "base");

    sample.write(FORMATTED, source(TAB + "int staged;\n"));
    sample.git("add", FORMATTED);
    sample.write(FORMATTED, source(TAB + "int staged;\n" + TAB + "int unstaged;\n"));
    Sample.Command commit = sample.git("commit", "-m", "partial");

    assertTrue(commit.output().contains("has unstaged changes"), commit.output());
    assertEquals(source(TAB + "int staged;\n"), sample.git("show", "HEAD:" + FORMATTED).output());
  }

  @Test
  void aFailingFormatterDoesNotStopTheCommit() {
    Sample sample = installedWithGradlew("exit 1\n");
    sample.write(FORMATTED, source(TAB + "int x;\n"));
    sample.git("add", FORMATTED);
    Sample.Command commit = sample.git("commit", "-m", "unformatted");

    assertTrue(commit.output().contains("formatting failed"), commit.output());
    assertEquals(source(TAB + "int x;\n"), sample.git("show", "HEAD:" + FORMATTED).output());
  }

  @Test
  void aProjectPathWithShellCharactersStillFormats() {
    Sample sample = installedWithGradlew(Sample.in(dir.resolve("team \"$HOME` robot")), FORMATTING_GRADLEW);
    sample.write(FORMATTED, source(TAB + "int x;\n"));
    sample.git("add", FORMATTED);
    sample.git("commit", "-q", "-m", "format");

    assertEquals(source("  int x;\n"), sample.git("show", "HEAD:" + FORMATTED).output());
  }

  // Builds once so the plugin installs the hook, then swaps in a stand-in for the project's gradlew
  private Sample installedWithGradlew(String script) {
    return installedWithGradlew(Sample.in(dir), script);
  }

  private Sample installedWithGradlew(Sample project, String script) {
    Sample sample = project.buildLine("tasks.register('spotlessApply')").setting("fixIntegerDivision = false").gitInit();
    sample.build(false, "compileJava");
    assertTrue(Files.exists(sample.file(HOOK)));
    sample.write("gradlew", script);
    return sample;
  }
}
