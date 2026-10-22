package io.github.kevinclark.hindsight.gradle;

import org.gradle.api.Project;
import org.gradle.api.Task;

/** Where this build runs: in CI or on a laptop, and whether it deploys to the robot. */
final class BuildContext {
  private final boolean ci;
  private volatile boolean deploying;

  private BuildContext(boolean ci) {
    this.ci = ci;
  }

  static BuildContext of(Project project) {
    // GitHub Actions and most other CI services set CI=true
    String ci = project.getProviders().environmentVariable("CI").getOrElse("");
    BuildContext build = new BuildContext(ci.equalsIgnoreCase("true"));
    // a deploy ships what is compiled now, so nothing may rewrite the source under it
    project.getGradle().getTaskGraph().whenReady(graph ->
        build.deploying = graph.getAllTasks().stream().anyMatch(BuildContext::isRobotDeploy));
    return build;
  }

  /**
   * GradleRIO's deploy work (finding the roboRIO, copying artifacts to it) is DeployUtils tasks. Task names are no
   * guide: robot projects have tasks like "eventDeploy" that run on every build.
   */
  private static boolean isRobotDeploy(Task task) {
    Class<?> type = task.getClass();
    while (type.getName().endsWith("_Decorated")) type = type.getSuperclass();
    return type.getName().startsWith("edu.wpi.first.deployutils.deploy.");
  }

  boolean ci() {
    return ci;
  }

  /** Known once Gradle has picked the tasks to run, so read it while tasks run, not while they are configured. */
  boolean deploying() {
    return deploying;
  }
}
