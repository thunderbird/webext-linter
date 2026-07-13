<script setup>
const raw = getUserInput()
const el = document.querySelector("div")
</script>

<template>
  <button @keydown.esc="el.innerHTML = raw; open = false">x</button>
</template>
