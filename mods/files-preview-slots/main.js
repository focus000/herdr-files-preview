// The files-preview mod's image slot files live here: image() only reloads a
// rewritten file under mods/. This mod draws nothing.
import { View, div } from "gpui-kit";

export default class Slots extends View {
  render() {
    return div();
  }
}
