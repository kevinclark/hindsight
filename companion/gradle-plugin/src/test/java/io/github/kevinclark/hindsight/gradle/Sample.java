package io.github.kevinclark.hindsight.gradle;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.gradle.testkit.runner.BuildResult;
import org.gradle.testkit.runner.GradleRunner;

/** A small robot-shaped project in a temp directory, and the builds and git commands the tests run on it. */
final class Sample {
  static final String RATIOS = "src/main/java/frc/robot/Ratios.java";
  static final String RATIOS_SOURCE = String.join("\n",
      "package frc.robot;",
      "",
      "public class Ratios {",
      "  public static final double GEAR_RATIO = 50 / 12;",
      "",
      "  public static boolean same() {",
      "    return java.util.Optional.of(1).equals(\"x\");",
      "  }",
      "}",
      "");

  private final Path dir;
  private final List<String> settings = new ArrayList<>();
  private final List<String> extra = new ArrayList<>();
  private boolean javaPlugin = true;

  private Sample(Path dir) {
    this.dir = dir;
  }

  static Sample in(Path dir) {
    return new Sample(dir);
  }

  /** A line inside {@code hindsight { }}, such as {@code formatHook = false}. */
  Sample setting(String line) {
    settings.add(line);
    return this;
  }

  /** A line at the end of build.gradle. */
  Sample buildLine(String line) {
    extra.add(line);
    return this;
  }

  Sample withoutJavaPlugin() {
    javaPlugin = false;
    return this;
  }

  Path dir() {
    return dir;
  }

  Path file(String relative) {
    return dir.resolve(relative);
  }

  String read(String relative) {
    try {
      return Files.readString(file(relative));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  void write(String relative, String text) {
    try {
      Path path = file(relative);
      Files.createDirectories(path.getParent());
      Files.writeString(path, text);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** Writes settings.gradle, build.gradle and Ratios.java (the last only if it isn't there yet). */
  Sample write() {
    write("settings.gradle", "rootProject.name = 'sample'\n");
    List<String> build = new ArrayList<>();
    build.add("plugins {");
    if (javaPlugin) build.add("  id 'java'");
    build.add("  id 'io.github.kevinclark.hindsight'");
    build.add("}");
    build.add("repositories { mavenCentral() }");
    if (!settings.isEmpty()) {
      build.add("hindsight {");
      settings.forEach(line -> build.add("  " + line));
      build.add("}");
    }
    build.addAll(extra);
    write("build.gradle", String.join("\n", build) + "\n");
    if (javaPlugin && !Files.exists(file(RATIOS))) write(RATIOS, RATIOS_SOURCE);
    return this;
  }

  BuildResult build(boolean ci, String... tasks) {
    return runner(ci, tasks).build();
  }

  BuildResult buildAndFail(boolean ci, String... tasks) {
    return runner(ci, tasks).buildAndFail();
  }

  private GradleRunner runner(boolean ci, String... tasks) {
    write();
    return GradleRunner.create()
        .withProjectDir(dir.toFile())
        .withPluginClasspath()
        .withTestKitDir(Path.of("build", "testkit").toAbsolutePath().toFile())
        .withEnvironment(environment(ci))
        .withArguments(withConsole(tasks));
  }

  private static List<String> withConsole(String[] tasks) {
    List<String> arguments = new ArrayList<>(List.of(tasks));
    arguments.add("--console=plain");
    return arguments;
  }

  /** withEnvironment replaces the whole environment, so start from ours and settle CI. */
  static Map<String, String> environment(boolean ci) {
    Map<String, String> env = new HashMap<>(System.getenv());
    env.remove("CI");
    if (ci) env.put("CI", "true");
    return env;
  }

  /** Runs a command in the project directory and returns its exit code and combined output. */
  Command run(String... command) {
    try {
      Process process = new ProcessBuilder(command).directory(dir.toFile()).redirectErrorStream(true).start();
      String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      if (!process.waitFor(60, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        throw new IllegalStateException("timed out: " + String.join(" ", command));
      }
      return new Command(process.exitValue(), output);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  /** Runs git and fails the test if git does. */
  Command git(String... args) {
    List<String> command = new ArrayList<>(List.of("git", "-c", "user.name=t", "-c", "user.email=t@example.com",
        "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"));
    command.addAll(List.of(args));
    Command result = run(command.toArray(new String[0]));
    if (result.exit() != 0) throw new IllegalStateException("git " + String.join(" ", args) + ": " + result.output());
    return result;
  }

  /** A git checkout with the build files tracked, as a cloned robot project is. */
  Sample gitInit() {
    write();
    git("init", "-q");
    git("add", "build.gradle", "settings.gradle");
    return this;
  }

  record Command(int exit, String output) {}
}
