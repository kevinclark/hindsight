package com.frc8033.hindsight;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

final class Fixtures {
  private Fixtures() {}

  /** A synthetic /proc file from src/test/resources/proc. */
  static String proc(String name) {
    try {
      return Files.readString(Path.of("src/test/resources/proc", name));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
