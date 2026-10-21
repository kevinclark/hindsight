package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import org.gradle.api.Project;
import org.gradle.api.logging.Logger;

/**
 * A git pre-commit hook that runs the project's own {@code spotlessApply} (no Spotless upgrade) and re-stages the
 * files that were staged. Installed by any build that compiles, so a clone gets it on its first build; a build with
 * {@code formatHook = false} removes it. It never touches a hook it didn't write.
 *
 * <p>Not installed in CI, in a copy that isn't a git checkout of this project, when the team points
 * {@code core.hooksPath} at hooks of its own, or in a project without Spotless.
 */
final class FormatHook {
  private static final String HOOK = "pre-commit";
  private static final String MARKER = "# Hindsight format hook";

  private FormatHook() {}

  static void apply(Project project, boolean wanted, BuildContext build) {
    if (build.ci()) return;
    boolean install = wanted && project.getTasks().getNames().contains("spotlessApply");
    project.getTasks().register("hindsightFormatHook", task -> {
      task.setDescription(install ? "Installs Hindsight's pre-commit format hook." : "Removes Hindsight's format hook.");
      task.doLast(t -> {
        try {
          update(project, install);
        } catch (IOException | RuntimeException e) {
          project.getLogger().info("Hindsight left the format hook alone: {}", e.toString());
        }
      });
    });
    project.getTasks().named("compileJava").configure(task -> task.dependsOn("hindsightFormatHook"));
  }

  private static void update(Project project, boolean install) throws IOException {
    Logger log = project.getLogger();
    File dir = project.getProjectDir();
    // tracked, so this is a checkout of the project and not a copy of it inside some other repository
    if (git(dir, "ls-files", "--error-unmatch", project.getBuildFile().getName()).isEmpty()) return;
    if (git(dir, "config", "core.hooksPath").filter(path -> !path.isBlank()).isPresent()) {
      log.info("Hindsight didn't install its format hook: core.hooksPath is set.");
      return;
    }
    Optional<String> hooks = git(dir, "rev-parse", "--git-path", "hooks");
    if (hooks.isEmpty()) return;
    Path hook = dir.toPath().resolve(hooks.get()).resolve(HOOK);
    boolean ours = Files.isRegularFile(hook) && Files.readString(hook).contains(MARKER);
    if (Files.exists(hook) && !ours) {
      log.info("Hindsight didn't install its format hook: {} already exists.", hook);
      return;
    }
    if (!install) {
      if (ours) Files.delete(hook);
      return;
    }
    String text = hookText(project);
    if (ours && Files.readString(hook).equals(text)) return;
    Files.createDirectories(hook.getParent());
    Files.writeString(hook, text);
    if (!System.getProperty("os.name").startsWith("Windows")) {
      Files.setPosixFilePermissions(hook, PosixFilePermissions.fromString("rwxr-xr-x"));
    }
    log.lifecycle("Hindsight installed a git pre-commit hook that formats staged files ({}).", hook);
  }

  private static String hookText(Project project) throws IOException {
    try (InputStream template = FormatHook.class.getResourceAsStream(HOOK)) {
      return new String(template.readAllBytes(), StandardCharsets.UTF_8)
          .replace("@PROJECT_DIR@", forShell(project.getProjectDir().getAbsolutePath()))
          .replace("@JAVA_HOME@", forShell(System.getProperty("java.home")));
    }
  }

  /**
   * A path inside the hook's double quotes: forward slashes (Git for Windows runs hooks in its own sh, which reads
   * C:/x but not C:\x), and the characters sh would expand there escaped.
   */
  private static String forShell(String path) {
    return path.replace('\\', '/').replaceAll("([\"$`])", "\\\\$1");
  }

  /** The command's first output line, or empty if git isn't there or the command failed. */
  private static Optional<String> git(File dir, String... args) {
    String[] command = new String[args.length + 1];
    command[0] = "git";
    System.arraycopy(args, 0, command, 1, args.length);
    try {
      Process git = new ProcessBuilder(command).directory(dir).redirectErrorStream(true).start();
      String output = new String(git.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
      if (!git.waitFor(10, TimeUnit.SECONDS) || git.exitValue() != 0) return Optional.empty();
      return Optional.of(output.lines().findFirst().orElse(""));
    } catch (IOException e) {
      return Optional.empty();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return Optional.empty();
    }
  }
}
