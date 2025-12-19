# JoyStick
Android Library for JoyStick View.

Customizable, small and lightweight.

## Sample App
![Sample app](/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png "Sample App image")

![Sample app image 1](/images/Screenshot_2015-10-30-21-43-47.png "Sample app image 1")

![Sample app image 2](/images/Screenshot_2015-11-02-18-05-49.png "Sample app image 2")

## Usage
Gradle Import: This github repository

```groovy

repositories {
    maven {
        url  uri("https://maven.pkg.github.com/etlegacy/JoyStick")
    }
}

dependencies {
    compile 'com.etlegacy.android:JoyStick:1.2.0'
}
```

## v1.1.0 BREAKING CHANGE!

* Made changes to JoyStickListener
  * Added Direction to onMove
  * Added Event calls for onTap and onDoubleTap

## Defaults:

1. Background = White
2. Button = Red
3. Button Radius = 25%
4. StayPut = false
5. Directional-Axis = 8

## Setup:

```xml
<com.erz.joysticklibrary.JoyStick
  android:id="@+id/joy1"
  android:layout_width="200dp"
  android:layout_height="200dp"
  android:layout_gravity="bottom"/>

<!-- default 25: radius percentage of full size of the view between 25% and 50% -->
<com.erz.joysticklibrary.JoyStick
    android:id="@+id/joy2"
    android:layout_width="200dp"
    android:layout_height="200dp"
    android:layout_gravity="bottom|right"
    app:padColor="#55ffffff"
    app:buttonColor="#55ff0000"
    app:stayPut="true"
    app:percentage="25"
    app:backgroundDrawable="R.drawable.background"
    app:buttonDrawable="R.drawable.button"/>
```

```java
JoyStick joyStick = findViewById(R.id.joyStick);

//or 

JoyStick joyStick = new JoyStick(context);
```

## JoyStickListener:

```java
//JoyStickListener Interface
public interface JoyStickListener {
        void onMove(JoyStick joyStick, double angle, double power, int direction);
        void onTap();
        void onDoubleTap();
}

//Set JoyStickListener
joyStick.setListener(this);
```
1. onMove: gets called everytime theres a touch interaction
2. onTap: gets called onSingleTapConfirmed
3. onDoubleTap: gets called onDoubleTap

## Directions:
1. DIRECTION_CENTER = -1
2. DIRECTION_LEFT = 0
3. DIRECTION_LEFT_UP = 1
4. DIRECTION_UP = 2
5. DIRECTION_UP_RIGHT = 3 
6. DIRECTION_RIGHT = 4
7. DIRECTION_RIGHT_DOWN = 5 
8. DIRECTION_DOWN = 6
9. DIRECTION_DOWN_LEFT = 7

To get JoyStick direction you can use

```java
joyStick.getDirection();
```
or get it from the JoyStickListener

## Axis Types:
1. TYPE_8_AXIS 
2. TYPE_4_AXIS 
3. TYPE_2_AXIS_LEFT_RIGHT 
4. TYPE_2_AXIS_UP_DOWN

To set Axis Type:

```java
joyStick.setType(JoyStick.TYPE_4_AXIS);
```

## Getters/Setters

```java
//Set GamePad Color
joyStick.setPadColor(Color.BLACK);

//Set Button Color
joyStick.setButtonColor(Color.RED);

//Set Background Image
joyStick.setPadBackground(resId);

//Set Button Image
joyStick.setButtonDrawable(resId);

//Set Button Scale
joyStick.setButtonRadiusScale(scale);

//Enable Button to Stay Put
joyStick.enableStayPut(enable);

//Get Power
joyStick.getPower();

//Get Angle
joyStick.getAngle();

//Get Angle in Degrees
joyStick.getAngleDegrees();
```

## License
    Copyright 2015 erz05

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
