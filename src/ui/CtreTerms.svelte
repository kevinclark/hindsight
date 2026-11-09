<!--
  The one sentence beside every button that downloads owlet from CTRE (ADR 13): downloading it means agreeing to CTRE's
  licence, between the user and CTRE. Hindsight asks for nothing and keeps no acceptance (Kevin, 2026-11-09).
-->
<script lang="ts">
  // Not imported from src/hoot/owlet.ts: that file is main-process only (`node:` imports). The same address is its LICENSE_URL.
  const LICENSE_URL = 'https://raw.githubusercontent.com/CrossTheRoadElec/Phoenix-Releases/refs/heads/master/CTRE_LICENSE.txt'
</script>

Downloading it means agreeing to <a href={LICENSE_URL} target="_blank" rel="noreferrer">CTRE's licence</a>, between you and CTRE.
