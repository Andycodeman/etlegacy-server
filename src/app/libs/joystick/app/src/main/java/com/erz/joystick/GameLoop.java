package com.erz.joystick;

import android.graphics.Canvas;
import android.view.SurfaceView;

/**
 * Created by edgarramirez on 7/17/15.
 */
public class GameLoop extends Thread {
    private static final long FPS = 24;
    private static final long ticksPS = 1000 / FPS;
    private final SurfaceView view;
    private boolean running = false;
    private Canvas canvas;

    public GameLoop(SurfaceView view) {
        this.view = view;
    }

    public void setRunning(boolean run) {
        running = run;
    }

    @Override
    public void run() {
        while (running) {
            long startTime = System.currentTimeMillis();
            try {
                canvas = view.getHolder().lockCanvas();
                synchronized (view.getHolder()) {
                    view.draw(canvas);
                }
            } finally {
                if (canvas != null) {
                    view.getHolder().unlockCanvasAndPost(canvas);
                }
            }
            long sleepTime = ticksPS - (System.currentTimeMillis() - startTime);
            if (sleepTime <= 0) {
                sleepTime = 20;
            }

            try {
                //noinspection BusyWait
                sleep(sleepTime);
            } catch (Exception ignore) {}
        }
    }
}