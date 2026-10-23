package io.github.kevinclark.hindsight.gradle;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class RobotStartsCheckTest {
  // The task needs GradleRIO, so the wiring condition is checked on its own
  @Test
  void checkRunsItInCiAndOnLaptopsOnlyByOptIn() {
    assertTrue(RobotStartsCheck.inCheck(true, false));
    assertTrue(RobotStartsCheck.inCheck(true, true));
    assertTrue(RobotStartsCheck.inCheck(false, true));
    assertFalse(RobotStartsCheck.inCheck(false, false));
  }
}
