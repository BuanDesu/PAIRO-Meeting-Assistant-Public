package com.pairo.meetingcopilot;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ModelStreamPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
