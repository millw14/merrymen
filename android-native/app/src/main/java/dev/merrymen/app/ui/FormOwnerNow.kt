package dev.merrymen.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import dev.merrymen.app.data.FormOwner
import dev.merrymen.app.data.Repository
import dev.merrymen.app.data.formOwnerOf

/**
 * WHOSE UNSAVED WORK A SCREEN IS HOLDING, NOW: the server and the wallet
 * ([FormOwner]). A screen keys every draft, half-given consent, armed control
 * and save report on this — `remember(form) { … }` — and binds its saves to
 * `ServerBound(form.serverTurn)`, so none of it survives onto another server
 * or another wallet, and none of it can be saved there.
 */
@Composable
fun currentFormOwner(repo: Repository): FormOwner {
  val turn by repo.serverTurn.collectAsState()
  val signedIn by repo.signedIn.collectAsState()
  return formOwnerOf(turn, signedIn)
}
