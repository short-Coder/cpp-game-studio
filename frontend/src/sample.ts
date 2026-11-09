export const SAMPLE: Record<string, string> = {
'CMakeLists.txt': '# Info only: the cloud builder compiles all .cpp/.c files directly with emcc + raylib.\ncmake_minimum_required(VERSION 3.16)\nproject(MyGame)\n',
'src/main.cpp': `#include "raylib.h"
#include "player.h"
int main() {
  InitWindow(800, 450, "My 2D Game");
  SetTargetFPS(60);
  Player p{400, 225};
  while (!WindowShouldClose()) {
    p.update(GetFrameTime());
    BeginDrawing();
    ClearBackground(RAYWHITE);
    p.draw();
    DrawText("Arrow keys / touch to move", 10, 10, 20, DARKGRAY);
    DrawFPS(10, 40);
    EndDrawing();
  }
  CloseWindow();
  return 0;
}
`,
'src/player.cpp': `#include "player.h"
#include "raylib.h"
void Player::update(float dt) {
  float s = 250 * dt;
  if (IsKeyDown(KEY_RIGHT)) x += s;
  if (IsKeyDown(KEY_LEFT)) x -= s;
  if (IsKeyDown(KEY_DOWN)) y += s;
  if (IsKeyDown(KEY_UP)) y -= s;
  if (GetTouchPointCount() > 0) { x = GetTouchX(); y = GetTouchY(); }
}
void Player::draw() { DrawCircle((int)x, (int)y, 20, MAROON); }
`,
'include/player.h': '#pragma once\nstruct Player { float x, y; void update(float dt); void draw(); };\n',
'c/hello.c': `#include <stdio.h>

/* C program: select this file and press "Run File" */
int main(void) {
    int hp = 100;
    printf("%d\\n", hp);
    hp = 80;  /* assignment */
    printf("%d\\n", hp);

    /* scanf needs input: a dialog will ask for it
    int n;
    printf("number? ");
    scanf("%d", &n);
    printf("you typed %d\\n", n * 2);
    */
    return 0;
}
`,
'samples/3d_main.cpp.txt': `// Rename to src/main.cpp (and delete the 2D one) for a 3D demo.
#include "raylib.h"
int main() {
  InitWindow(800, 450, "3D");
  Camera3D cam{{6,6,6},{0,0,0},{0,1,0},45.0f,CAMERA_PERSPECTIVE};
  SetTargetFPS(60);
  while (!WindowShouldClose()) {
    UpdateCamera(&cam, CAMERA_ORBITAL);
    BeginDrawing(); ClearBackground(RAYWHITE);
    BeginMode3D(cam); DrawCube({0,1,0},2,2,2,RED); DrawCubeWires({0,1,0},2,2,2,MAROON); DrawGrid(10,1); EndMode3D();
    EndDrawing();
  }
  CloseWindow(); return 0;
}
`,
};
