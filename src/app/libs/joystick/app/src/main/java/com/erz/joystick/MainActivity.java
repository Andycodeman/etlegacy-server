package com.erz.joystick;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;

import com.erz.joysticklibrary.JoyStick;

public class MainActivity extends Activity implements JoyStick.JoyStickListener {

    private GameView gameView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        gameView = findViewById(R.id.game);
        JoyStick joy1 = findViewById(R.id.joy1);
        joy1.setListener(this);
        joy1.setPadColor(Color.parseColor("#55ffffff"));
        joy1.setButtonColor(Color.parseColor("#55ff0000"));

        JoyStick joy2 = findViewById(R.id.joy2);
        joy2.setListener(this);
        joy2.enableStayPut(true);
        joy2.setPadBackground(R.drawable.pad);
        joy2.setButtonDrawable(R.drawable.button);
    }

    @Override
    public void onMove(JoyStick joyStick, double angle, double power, int direction) {
        int id = joyStick.getId();

        if (id == R.id.joy1) {
            gameView.move(angle, power);
        } else if(id == R.id.joy2) {
            gameView.rotate(angle);
        } else {
            Log.w("onMove", "Wrong id detected on the move");
        }
    }

    @Override
    public void onTap() {}

    @Override
    public void onDoubleTap() {}
}