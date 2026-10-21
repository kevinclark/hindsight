#!/bin/sh
# Builds a small git repo of invented robot code with two commits, for testing the code check's comparison
# (tests/code-check-cli.test.ts and .github/workflows/code-check-action.yml). Usage: make-code-check-sample.sh <empty folder>
#
#   base: Gears.java has two whole-number divisions (two findings).
#   head: one of them is fixed (50.0 / 12), the other moves down a line (a comment above it), and Ratios.java adds
#         twelve new divisions. So at the head: 13 findings, 12 new (more than GitHub's 10 warnings per step), 1 fixed.
# The base commit is printed on the last line of output.
set -eu
dir="$1"
mkdir -p "$dir/src/main/java/frc/sample"
cd "$dir"
git init -q -b main
git config user.name "Sample" && git config user.email "sample@example.com"

cat > src/main/java/frc/sample/Gears.java <<'JAVA'
package frc.sample;

public class Gears {
  static final double DRIVE_RATIO = 50 / 12;
  static final double KICKER_RATIO = 30 / 12;
}
JAVA
git add -A && git commit -q -m "base: two whole-number divisions"
base=$(git rev-parse HEAD)

cat > src/main/java/frc/sample/Gears.java <<'JAVA'
package frc.sample;

public class Gears {
  static final double DRIVE_RATIO = 50.0 / 12;
  // The kicker ratio is still a whole-number division.
  static final double KICKER_RATIO = 30 / 12;
}
JAVA
{
  echo "package frc.sample;"
  echo
  echo "public class Ratios {"
  for n in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "  static final double RATIO_$n = $((n * 10 + 7)) / 4;"; done
  echo "}"
} > src/main/java/frc/sample/Ratios.java
git add -A && git commit -q -m "head: one fixed, one moved, twelve new"
echo "$base"
